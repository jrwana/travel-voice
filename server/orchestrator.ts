import { randomUUID } from "node:crypto";
import type {
  ChangeOption,
  EscalationReason,
  PublicReservation,
  ServerEvent,
  ToolCallTrace,
} from "../src/shared/contracts.js";
import { scenarioById } from "../src/shared/scenarios.js";
import { evaluatePolicy } from "./domain/policy.js";
import {
  type ManageReservationInput,
  ReservationToolError,
} from "./domain/reservationTool.js";
import { workflowState } from "./domain/workflow.js";
import { CallSession } from "./session.js";
import { AgentService } from "./services/agent.js";

export type EmitEvent = (event: ServerEvent) => void;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(`${iso}T00:00:00.000Z`));
}

function formatDelta(cents: number): string {
  if (cents === 0) return "with no price difference";
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Math.abs(cents) / 100,
  );
  return cents > 0 ? `for ${amount} more` : `saving ${amount}`;
}

function publicResult(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (structuredClone(value) as Record<string, unknown>) : {};
}

export class Orchestrator {
  constructor(private readonly agent: AgentService) {}

  async startCall(session: CallSession, scenarioId: string, requestedMode: "live" | "playback", emit: EmitEvent) {
    const mode = requestedMode === "live" && session.aiAvailable ? "live" : "playback";
    session.startCall(scenarioId, mode);
    emit({ type: "snapshot", snapshot: session.snapshot() });
    if (requestedMode === "live" && mode === "playback") {
      emit({
        type: "notice",
        level: "warning",
        message: "Live AI is unavailable, so this call is running in clearly labeled Scenario Playback mode.",
      });
    }
    await this.speak(
      session,
      "Hello, you've reached Meridian and Pine Travel. I'm an AI assistant in a fictional demo using synthetic reservations. I can help change hotel dates, but I cannot make a real booking or charge. Please share your confirmation code and last name.",
      emit,
    );
    session.send({ type: "GREETED" });
    session.voiceMode = "listening";
    emit({ type: "snapshot", snapshot: session.snapshot() });
  }

  async handleCallerText(session: CallSession, text: string, emit: EmitEvent, recordTranscript = true): Promise<void> {
    if (!session.callId || session.outcome) return;
    const turnStartedAt = performance.now();
    session.voiceMode = "processing";
    if (recordTranscript) {
      session.beginTurn();
      const turn = session.completeTranscript(text);
      emit({ type: "transcript.final", turn });
    }
    emit({ type: "snapshot", snapshot: session.snapshot() });

    const policy = evaluatePolicy(text);
    if (policy.escalationReasons.length) {
      await this.escalate(session, policy.escalationReasons, text, emit);
      return;
    }
    if (policy.unsupported) {
      if (session.offTopicCount === 0) {
        session.offTopicCount += 1;
        await this.speak(
          session,
          "I can only help with a fictional hotel-date change in this demo. Please share your confirmation code and last name, or continue with the date change.",
          emit,
        );
        return;
      }
      session.send({ type: "UNSUPPORTED" });
      await this.speak(session, "I can't help with that request, so I'll end this demo call safely.", emit);
      session.complete("unsupported");
      emit({ type: "snapshot", snapshot: session.snapshot() });
      return;
    }

    const state = workflowState(session.workflow);
    const parsed = await this.agent.interpret(state, text, session.mode === "live");
    session.metrics.llmMs = parsed.durationMs;

    switch (state) {
      case "identifying":
        await this.handleIdentity(session, parsed.confirmationCode, parsed.lastName, emit);
        break;
      case "collecting_dates":
        await this.handleDates(session, parsed.checkIn, parsed.checkOut, emit);
        break;
      case "awaiting_selection":
        if (parsed.wantsDateChange && parsed.checkIn && parsed.checkOut) {
          session.send({ type: "CHANGE_DATES" });
          await this.handleDates(session, parsed.checkIn, parsed.checkOut, emit);
        } else {
          await this.handleSelection(session, parsed.optionNumber, emit);
        }
        break;
      case "awaiting_confirmation":
        if (parsed.wantsDateChange && parsed.checkIn && parsed.checkOut) {
          session.send({ type: "CHANGE_DATES" });
          await this.handleDates(session, parsed.checkIn, parsed.checkOut, emit);
        } else {
          await this.handleConfirmation(session, parsed.affirmed, parsed.denied, emit);
        }
        break;
      default:
        await this.speak(session, "One moment while I keep this demo call in a safe workflow state.", emit);
    }
    session.metrics.turnTotalMs = Math.round(performance.now() - turnStartedAt);
    emit({ type: "snapshot", snapshot: session.snapshot() });
  }

  async correctIdentity(
    session: CallSession,
    confirmationCode: string,
    lastName: string,
    emit: EmitEvent,
  ): Promise<void> {
    const text = `My confirmation code is ${confirmationCode} and the last name is ${lastName}.`;
    await this.handleCallerText(session, text, emit);
  }

  async correctDates(session: CallSession, checkIn: string, checkOut: string, emit: EmitEvent): Promise<void> {
    await this.handleCallerText(session, `Change the stay from ${checkIn} to ${checkOut}.`, emit);
  }

  async endCall(session: CallSession, emit: EmitEvent): Promise<void> {
    if (!session.callId || session.outcome) return;
    session.addTurn("system", "Caller ended the demo call.");
    session.complete("abandoned");
    emit({ type: "snapshot", snapshot: session.snapshot() });
  }

  async playScenario(session: CallSession, scenarioId: string, emit: EmitEvent): Promise<void> {
    const scenario = scenarioById(scenarioId);
    await this.startCall(session, scenario.id, "playback", emit);
    const assertions: string[] = [];
    for (const scriptedTurn of scenario.turns) {
      await wait(500);
      session.beginTurn();
      session.notePartial(scriptedTurn.caller.slice(0, Math.max(12, Math.round(scriptedTurn.caller.length * 0.55))));
      emit({ type: "transcript.partial", text: session.partialTranscript });
      emit({ type: "snapshot", snapshot: session.snapshot() });
      await wait(250);
      const turn = session.completeTranscript(scriptedTurn.caller);
      emit({ type: "transcript.final", turn });
      await this.handleCallerText(session, scriptedTurn.caller, emit, false);
      if (scriptedTurn.expectState) {
        const actual = workflowState(session.workflow);
        assertions.push(
          actual === scriptedTurn.expectState
            ? `PASS state ${actual}`
            : `FAIL expected ${scriptedTurn.expectState}, received ${actual}`,
        );
      }
      if (session.outcome) break;
    }
    const outcomePass = session.outcome === scenario.expectedOutcome;
    const reasonsPass = scenario.expectedReasons.every((reason) => session.escalationReasons.includes(reason));
    assertions.push(
      outcomePass
        ? `PASS outcome ${scenario.expectedOutcome}`
        : `FAIL expected outcome ${scenario.expectedOutcome}, received ${session.outcome ?? "none"}`,
    );
    assertions.push(reasonsPass ? "PASS escalation reasons" : "FAIL escalation reasons");
    emit({
      type: "scenario.complete",
      scenarioId: scenario.id,
      passed: assertions.every((assertion) => assertion.startsWith("PASS")),
      assertions,
    });
  }

  private async handleIdentity(
    session: CallSession,
    confirmationCode: string | undefined,
    lastName: string | undefined,
    emit: EmitEvent,
  ) {
    session.identity.confirmationCode = confirmationCode ?? session.identity.confirmationCode;
    session.identity.lastName = lastName ?? session.identity.lastName;
    if (!session.identity.confirmationCode || !session.identity.lastName) {
      if (session.incrementRepair("identity") >= 2) {
        await this.escalate(session, ["uncertainty"], "Reservation identity could not be verified.", emit);
        return;
      }
      await this.speak(session, "I need both the confirmation code and the last name on the reservation.", emit);
      return;
    }

    const result = await this.runTool(
      session,
      {
        action: "find",
        confirmationCode: session.identity.confirmationCode,
        lastName: session.identity.lastName,
      },
      emit,
    );
    if (!result.ok) {
      if (result.code === "NOT_FOUND" && session.incrementRepair("identity") < 2) {
        session.identity = {};
        await this.speak(
          session,
          "I couldn't match those details. Please try the confirmation code and last name one more time.",
          emit,
        );
        return;
      }
      await this.escalate(
        session,
        result.code === "NOT_FOUND" ? ["uncertainty"] : ["tool_failure", "uncertainty"],
        "Reservation lookup could not be completed safely.",
        emit,
      );
      return;
    }
    session.reservation = result.value.reservation as PublicReservation;
    session.send({ type: "FOUND" });
    session.send({ type: "REQUEST_DATES" });
    const stay = session.reservation.stay;
    await this.speak(
      session,
      `I found ${stay.hotelName} in ${stay.city}, from ${formatDate(stay.checkIn)} to ${formatDate(stay.checkOut)}. What new check-in and check-out dates would you like?`,
      emit,
    );
  }

  private async handleDates(
    session: CallSession,
    checkIn: string | undefined,
    checkOut: string | undefined,
    emit: EmitEvent,
  ) {
    session.requestedDates.checkIn = checkIn ?? session.requestedDates.checkIn;
    session.requestedDates.checkOut = checkOut ?? session.requestedDates.checkOut;
    if (!session.requestedDates.checkIn || !session.requestedDates.checkOut) {
      if (session.incrementRepair("dates") >= 2) {
        await this.escalate(session, ["uncertainty"], "The requested dates remained unclear.", emit);
        return;
      }
      await this.speak(session, "Please give me both the new check-in and check-out dates.", emit);
      return;
    }
    session.send({ type: "DATES_READY" });
    await this.performQuote(session, emit);
  }

  private async performQuote(session: CallSession, emit: EmitEvent) {
    if (!session.reservation || !session.requestedDates.checkIn || !session.requestedDates.checkOut) {
      await this.escalate(session, ["uncertainty"], "Required reservation or date details were missing.", emit);
      return;
    }
    const result = await this.runTool(
      session,
      {
        action: "quote_date_change",
        reservationId: session.reservation.reservationId,
        checkIn: session.requestedDates.checkIn,
        checkOut: session.requestedDates.checkOut,
      },
      emit,
    );
    if (!result.ok) {
      if (result.code === "INVALID_DATES") {
        session.send({ type: "INVALID_DATES" });
        session.requestedDates = {};
        if (session.incrementRepair("dates") >= 2) {
          await this.escalate(session, ["uncertainty"], "Valid hotel dates could not be established.", emit);
        } else {
          await this.speak(
            session,
            "Those dates don't form a valid stay. Check-out must be after check-in. Please try both dates again.",
            emit,
          );
        }
        return;
      }
      await this.escalate(session, ["tool_failure", "uncertainty"], "Availability could not be quoted safely.", emit);
      return;
    }
    session.quoteToken = String(result.value.quoteToken);
    session.options = result.value.options as ChangeOption[];
    session.selectedOption = undefined;
    session.send({ type: "QUOTED" });
    const spokenOptions = session.options
      .map(
        (option, index) =>
          `Option ${index + 1}: ${formatDate(option.checkIn)} to ${formatDate(option.checkOut)}, ${option.roomType}, ${formatDelta(option.priceDeltaCents)}`,
      )
      .join(". ");
    await this.speak(session, `I found three mock options. ${spokenOptions}. Which option would you like?`, emit);
    session.send({ type: "OPTIONS_PRESENTED" });
    session.voiceMode = "listening";
  }

  private async handleSelection(session: CallSession, optionNumber: 1 | 2 | 3 | undefined, emit: EmitEvent) {
    if (!optionNumber || !session.options[optionNumber - 1]) {
      if (session.incrementRepair("selection") >= 2) {
        await this.escalate(session, ["uncertainty"], "An available option could not be selected reliably.", emit);
        return;
      }
      await this.speak(session, "Please say first, second, or third option.", emit);
      return;
    }
    session.selectedOption = session.options[optionNumber - 1];
    session.send({ type: "SELECT" });
    const option = session.selectedOption;
    await this.speak(
      session,
      `To recap: ${formatDate(option.checkIn)} to ${formatDate(option.checkOut)}, ${option.roomType}, ${formatDelta(option.priceDeltaCents)}. This is fictional and no payment will occur. Would you like me to confirm this mock change?`,
      emit,
    );
  }

  private async handleConfirmation(session: CallSession, affirmed: boolean, denied: boolean, emit: EmitEvent) {
    if (denied) {
      session.selectedOption = undefined;
      session.send({ type: "CHANGE_SELECTION" });
      await this.speak(session, "No change was made. Please choose the first, second, or third option.", emit);
      return;
    }
    if (!affirmed || !session.selectedOption || !session.quoteToken) {
      if (session.incrementRepair("confirmation") >= 2) {
        await this.escalate(session, ["uncertainty"], "Explicit confirmation could not be established.", emit);
        return;
      }
      await this.speak(session, "I need an explicit yes to confirm this mock change, or you can say no.", emit);
      return;
    }
    session.send({ type: "CONFIRM" });
    const result = await this.runTool(
      session,
      {
        action: "confirm_date_change",
        quoteToken: session.quoteToken,
        optionId: session.selectedOption.optionId,
        idempotencyKey: `${session.callId}:${session.quoteToken}:${session.selectedOption.optionId}`,
      },
      emit,
    );
    if (!result.ok) {
      if (result.code === "STALE_QUOTE" && session.incrementRepair("stale_quote") === 1) {
        session.send({ type: "REQUOTE" });
        await this.speak(session, "That mock quote expired. I'll refresh the three options before asking you to confirm again.", emit);
        await this.performQuote(session, emit);
        return;
      }
      await this.escalate(session, ["tool_failure", "uncertainty"], "The date change could not be applied safely.", emit);
      return;
    }
    session.reservation = result.value.reservation as PublicReservation;
    session.send({ type: "CHANGED" });
    const confirmation = String(result.value.mockConfirmationNumber);
    await this.speak(
      session,
      `Your fictional stay at ${session.reservation.stay.hotelName} is now changed to ${formatDate(session.reservation.stay.checkIn)} through ${formatDate(session.reservation.stay.checkOut)}. Your mock confirmation is ${confirmation}. No real booking or payment was made.`,
      emit,
    );
    session.complete("changed");
  }

  private async runTool(
    session: CallSession,
    input: ManageReservationInput,
    emit: EmitEvent,
  ): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; code: string }> {
    const started = performance.now();
    const trace: ToolCallTrace = {
      id: `tool_${randomUUID()}`,
      name: "manage_reservation",
      action: input.action,
      status: "running",
      arguments: publicResult(input),
      startedAt: new Date().toISOString(),
    };
    session.toolCalls.push(trace);
    emit({ type: "snapshot", snapshot: session.snapshot() });
    try {
      if (session.mode === "playback") await wait(140);
      const value = await session.reservationTool.manageReservation(input);
      trace.status = "success";
      trace.result = publicResult(value);
      trace.durationMs = Math.max(1, Math.round(performance.now() - started));
      session.metrics.toolMs = trace.durationMs;
      emit({ type: "snapshot", snapshot: session.snapshot() });
      return { ok: true, value };
    } catch (error) {
      trace.status = "error";
      trace.durationMs = Math.max(1, Math.round(performance.now() - started));
      trace.errorCode = error instanceof ReservationToolError ? error.code : "INTERNAL_ERROR";
      trace.result = { message: error instanceof Error ? error.message : "Unknown tool error" };
      session.metrics.toolMs = trace.durationMs;
      emit({ type: "snapshot", snapshot: session.snapshot() });
      return { ok: false, code: trace.errorCode };
    }
  }

  private async escalate(
    session: CallSession,
    reasons: EscalationReason[],
    requestSummary: string,
    emit: EmitEvent,
  ) {
    session.escalationReasons = [...new Set([...session.escalationReasons, ...reasons])];
    session.send({ type: "ESCALATE" });
    const lastCallerTurn = [...session.transcript].reverse().find((turn) => turn.role === "caller")?.text ?? requestSummary;
    session.handoffSummary = {
      queueLabel: "Priority travel care · simulated queue",
      reasons: session.escalationReasons,
      traveler: session.reservation?.travelerDisplayName,
      confirmationCode: session.reservation?.confirmationCode ?? session.identity.confirmationCode,
      requestSummary,
      lastCallerTurn,
    };
    await this.speak(
      session,
      "This request needs a human travel specialist. I've stopped the automated workflow and prepared a summary for a simulated handoff. No reservation or payment was changed.",
      emit,
    );
    session.complete("escalated");
    emit({ type: "snapshot", snapshot: session.snapshot() });
  }

  private async speak(session: CallSession, text: string, emit: EmitEvent) {
    session.voiceMode = "speaking";
    session.agentPrompt = text;
    const turn = session.addTurn("agent", text);
    emit({ type: "snapshot", snapshot: session.snapshot() });
    const speech = await this.agent.synthesize(text, session.mode === "live");
    session.metrics.ttsMs = speech.durationMs;
    emit({
      type: "agent.message",
      turn,
      audioBase64: speech.audio?.toString("base64"),
      audioMimeType: speech.audio ? "audio/mpeg" : undefined,
    });
    if (!session.outcome) session.voiceMode = "listening";
    emit({ type: "snapshot", snapshot: session.snapshot() });
  }
}
