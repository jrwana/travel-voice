import { describe, expect, it, vi } from "vitest";
import type { ServerEvent } from "../src/shared/contracts.js";
import { demoScenarios } from "../src/shared/scenarios.js";
import { workflowState } from "../server/domain/workflow.js";
import { Orchestrator } from "../server/orchestrator.js";
import { CallSession } from "../server/session.js";
import { AgentService } from "../server/services/agent.js";
import { silentServiceLogger } from "../server/services/logger.js";
import { NarrationFixtureStore, NarratorService } from "../server/services/narrator.js";

describe("five scripted evaluation calls", () => {
  for (const scenario of demoScenarios) {
    it(`${scenario.id}: ${scenario.title}`, async () => {
      const agent = new AgentService("");
      const orchestrator = new Orchestrator(agent);
      const session = new CallSession(`test_${scenario.id}`, false, "test playback");
      const events: ServerEvent[] = [];
      const emit = (event: ServerEvent) => events.push(event);

      await orchestrator.startCall(session, scenario.id, "playback", emit);
      expect(workflowState(session.workflow)).toBe("identifying");
      expect(session.transcript[0]?.text).toContain("AI assistant");
      expect(session.transcript[0]?.text).toContain("synthetic reservations");

      for (let index = 0; index < scenario.turns.length; index += 1) {
        const turn = scenario.turns[index];
        const confirmCallsBefore = session.toolCalls.filter((call) => call.action === "confirm_date_change");
        if (scenario.expectedOutcome === "changed" && index < scenario.turns.length - 1) {
          expect(confirmCallsBefore).toHaveLength(0);
        }
        await orchestrator.handleCallerText(session, turn.caller, emit);
        expect(workflowState(session.workflow), `state after: ${turn.caller}`).toBe(turn.expectState);
      }

      expect(session.outcome).toBe(scenario.expectedOutcome);
      expect(session.escalationReasons).toEqual(expect.arrayContaining(scenario.expectedReasons));
      expect(session.history).toHaveLength(1);
      expect(session.history[0].outcome).toBe(scenario.expectedOutcome);
      expect(session.toolCalls.every((call) => call.durationMs !== undefined)).toBe(true);
      const agentTurns = session.transcript.filter((turn) => turn.role === "agent");
      expect(agentTurns.length).toBeGreaterThan(0);
      expect(agentTurns.every((turn) => turn.narration?.renderedBy === "fixture")).toBe(true);
      expect(agentTurns.every((turn) => turn.narration?.fidelity.status === "verified")).toBe(true);
      expect(
        session.snapshot().transcript.filter((turn) => turn.role === "agent").every(
          (turn) => turn.narration?.renderedBy === "fixture",
        ),
      ).toBe(true);

      if (scenario.expectedOutcome === "changed") {
        expect(session.options).toHaveLength(3);
        expect(session.selectedOption).toBeDefined();
        expect(session.reservation?.status).toBe("changed");
        expect(session.toolCalls.map((call) => call.action)).toContain("confirm_date_change");
        expect(session.toolCalls.filter((call) => call.action === "confirm_date_change")).toHaveLength(1);
        expect(session.transcript.at(-1)?.text).toContain("mock confirmation");
        expect(session.transcript.at(-1)?.text).toContain("No real booking or payment");
      } else {
        expect(session.handoffSummary?.queueLabel).toContain("simulated queue");
        expect(session.handoffSummary?.reasons).toEqual(expect.arrayContaining(scenario.expectedReasons));
        expect(session.toolCalls.some((call) => call.action === "confirm_date_change")).toBe(false);
        expect(session.transcript.at(-1)?.text).toContain("human travel specialist");
      }

      expect(events.some((event) => event.type === "snapshot")).toBe(true);
      expect(events.some((event) => event.type === "agent.message")).toBe(true);
    });
  }
});

describe("verified scenario suite", () => {
  it("runs all five scenarios independently and reports replay provenance", async () => {
    const orchestrator = new Orchestrator(new AgentService(""));
    const session = new CallSession("test_verified_suite", false, "test playback");
    const events: ServerEvent[] = [];
    const results = await orchestrator.playScenarioSuite(
      session,
      (event) => events.push(event),
      () => true,
      async () => undefined,
    );

    expect(results).toHaveLength(5);
    expect(results.every((result) => result.passed)).toBe(true);
    expect(results.every((result) => result.actualOutcome === result.expectedOutcome)).toBe(true);
    expect(results.every((result) => result.narrationSources.fixture > 0)).toBe(true);
    expect(results.every((result) => result.narrationSources.model === 0)).toBe(true);
    expect(results.every((result) => result.narrationSources.template === 0)).toBe(true);
    expect(events[0]).toEqual({ type: "scenario.suite.started", total: 5 });
    expect(events.filter((event) => event.type === "scenario.complete")).toHaveLength(5);
    expect(events.at(-1)).toMatchObject({
      type: "scenario.suite.complete",
      passed: true,
      cancelled: false,
    });
  });

  it("stops before the next scenario when a suite run is cancelled", async () => {
    const orchestrator = new Orchestrator(new AgentService(""));
    const session = new CallSession("test_cancelled_suite", false, "test playback");
    let checks = 0;
    const events: ServerEvent[] = [];
    const results = await orchestrator.playScenarioSuite(
      session,
      (event) => events.push(event),
      () => ++checks === 1,
      async () => undefined,
    );

    expect(results).toHaveLength(1);
    expect(events.at(-1)).toMatchObject({
      type: "scenario.suite.complete",
      passed: false,
      cancelled: true,
    });
  });
});

describe("live exploration identity", () => {
  it("labels freeform live calls separately from replay scenarios", async () => {
    const orchestrator = new Orchestrator(new AgentService(""));
    const session = new CallSession("test_live_exploration", true);
    await orchestrator.startCall(session, "happy_exact", "live", () => undefined);
    expect(session.scenarioId).toBe("live_exploration");
  });

  it("accepts paraphrased model interpretations while deterministic code guards mutation", async () => {
    const agent = new AgentService("");
    const fixtureStore = NarrationFixtureStore.load();
    const occurrences = new Map<string, number>();
    const narrator = new NarratorService({
      generator: async ({ intent }) => {
        const occurrence = (occurrences.get(intent) ?? 0) + 1;
        occurrences.set(intent, occurrence);
        const fixture = fixtureStore.get("happy_exact", intent, occurrence);
        if (!fixture) throw new Error(`Missing test fixture for ${intent}:${occurrence}`);
        return fixture.candidateText;
      },
    });
    const interpretations = vi.spyOn(agent, "interpret");
    interpretations
      .mockResolvedValueOnce({
        intent: "find_reservation",
        confirmationCode: "MPT-4821",
        lastName: "Lee",
        affirmed: false,
        denied: false,
        wantsDateChange: true,
        usedModel: true,
        durationMs: 4,
      })
      .mockResolvedValueOnce({
        intent: "change_dates",
        checkIn: "2027-10-20",
        checkOut: "2027-10-24",
        affirmed: false,
        denied: false,
        wantsDateChange: true,
        usedModel: true,
        durationMs: 4,
      })
      .mockResolvedValueOnce({
        intent: "select_option",
        optionNumber: 2,
        affirmed: false,
        denied: false,
        wantsDateChange: false,
        usedModel: true,
        durationMs: 4,
      })
      .mockResolvedValueOnce({
        intent: "confirm",
        affirmed: true,
        denied: false,
        wantsDateChange: false,
        usedModel: true,
        durationMs: 4,
      });

    const orchestrator = new Orchestrator(agent, narrator);
    const session = new CallSession("test_live_paraphrases", true);
    const emit = (_event: ServerEvent) => undefined;
    await orchestrator.startCall(session, "live_exploration", "live", emit);
    await orchestrator.handleCallerText(session, "It's the Lisbon trip under MPT 4821—surname Lee.", emit);
    await orchestrator.handleCallerText(session, "Could you shift it to the twentieth through the twenty-fourth of October?", emit);
    await orchestrator.handleCallerText(session, "The middle choice feels right.", emit);

    expect(workflowState(session.workflow)).toBe("awaiting_confirmation");
    expect(session.toolCalls.some((call) => call.action === "confirm_date_change")).toBe(false);

    await orchestrator.handleCallerText(session, "Yes, please make that exact mock change.", emit);

    expect(session.outcome).toBe("changed");
    expect(session.toolCalls.filter((call) => call.action === "confirm_date_change")).toHaveLength(1);
    expect(session.transcript.filter((turn) => turn.role === "agent").every(
      (turn) => turn.narration?.renderedBy === "model" && turn.narration.fidelity.status === "verified",
    )).toBe(true);
    expect(interpretations).toHaveBeenCalledTimes(4);
  });
});

describe("escalation ordering", () => {
  it("commits deterministic escalation before the narrator phrases the handoff", async () => {
    const agent = new AgentService("", silentServiceLogger);
    const interpret = vi.spyOn(agent, "interpret");
    const observed: Array<{ intent: string; state: string; handoffReady: boolean }> = [];
    let session: CallSession;
    const narrator = new NarratorService({
      logger: silentServiceLogger,
      generator: async ({ intent }) => {
        observed.push({
          intent,
          state: workflowState(session.workflow),
          handoffReady: Boolean(session.handoffSummary),
        });
        if (intent === "greeting") {
          return "Hello, I'm the AI assistant for {{agency_name}}, a fictional AI demo using synthetic reservations. I only support hotel-date changes and cannot make a real booking or charge. Please share your confirmation code and last name.";
        }
        return "This request involves {{escalation_reasons}} and needs a human travel specialist. A summary was prepared for a simulated handoff. No reservation or payment was changed.";
      },
    });
    session = new CallSession("test_escalation_order", true);
    const orchestrator = new Orchestrator(agent, narrator);
    const emit = (_event: ServerEvent) => undefined;

    await orchestrator.startCall(session, "payment_penalty", "live", emit);
    await orchestrator.handleCallerText(
      session,
      "I cancelled and you charged me a penalty twice. I dispute that charge.",
      emit,
    );

    const escalationRender = observed.find((entry) => entry.intent === "escalate");
    expect(escalationRender).toEqual({
      intent: "escalate",
      state: "escalated",
      handoffReady: true,
    });
    expect(interpret).not.toHaveBeenCalled();
    expect(session.toolCalls).toHaveLength(0);
    expect(session.outcome).toBe("escalated");
    expect(session.transcript.at(-1)?.narration?.renderedBy).toBe("model");
  });
});

describe("explicit confirmation boundary", () => {
  it("does not invoke the mutation tool for an ambiguous interpreted confirmation", async () => {
    const agent = new AgentService("");
    const orchestrator = new Orchestrator(agent);
    const session = new CallSession("test_ambiguous_confirmation", false, "test playback");
    const emit = (_event: ServerEvent) => undefined;

    await orchestrator.startCall(session, "happy_exact", "playback", emit);
    await orchestrator.handleCallerText(session, "MPT-4821, last name Lee", emit);
    await orchestrator.handleCallerText(session, "October 20 through October 24, 2027", emit);
    await orchestrator.handleCallerText(session, "The first option", emit);

    vi.spyOn(agent, "interpret").mockResolvedValue({
      intent: "confirm",
      usedModel: true,
      durationMs: 1,
      affirmed: false,
      denied: false,
      wantsDateChange: false,
    });
    await orchestrator.handleCallerText(session, "Yes—actually, I'm not sure.", emit);

    expect(workflowState(session.workflow)).toBe("awaiting_confirmation");
    expect(session.outcome).toBeUndefined();
    expect(session.toolCalls.filter((call) => call.action === "confirm_date_change")).toHaveLength(0);
    expect(session.transcript.at(-1)?.text).toContain("explicit yes");
  });
});
