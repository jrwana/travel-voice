import { randomUUID } from "node:crypto";
import type { AnyActorRef } from "xstate";
import type {
  CallHistoryItem,
  CallOutcome,
  CallSnapshot,
  ChangeOption,
  DemoMode,
  EscalationReason,
  HandoffSummary,
  LatencyMetrics,
  PublicReservation,
  ToolCallTrace,
  TranscriptTurn,
  SpeechIntent,
  SpeechRenderTrace,
  VoiceMode,
} from "../src/shared/contracts.js";
import { scenarioById } from "../src/shared/scenarios.js";
import { MockReservationTool } from "./domain/reservationTool.js";
import { newWorkflowActor, workflowState, type WorkflowEvent } from "./domain/workflow.js";

export class CallSession {
  readonly reservationTool = new MockReservationTool();
  workflow: AnyActorRef = newWorkflowActor();
  lastActiveAt = Date.now();
  callTimestamps: number[] = [];
  scenarioId = "happy_exact";
  mode: DemoMode = "playback";
  voiceMode: VoiceMode = "idle";
  callId?: string;
  transcript: TranscriptTurn[] = [];
  partialTranscript = "";
  toolCalls: ToolCallTrace[] = [];
  metrics: LatencyMetrics = {};
  reservation?: PublicReservation;
  options: ChangeOption[] = [];
  selectedOption?: ChangeOption;
  quoteToken?: string;
  outcome?: CallOutcome;
  escalationReasons: EscalationReason[] = [];
  handoffSummary?: HandoffSummary;
  history: CallHistoryItem[] = [];
  startedAt?: string;
  endedAt?: string;
  agentPrompt?: string;
  identity: { confirmationCode?: string; lastName?: string } = {};
  requestedDates: { checkIn?: string; checkOut?: string } = {};
  repairCounts: Record<string, number> = {};
  offTopicCount = 0;
  firstPartialAtMs?: number;
  turnStartedAtMs?: number;
  stateHistory: string[] = [];
  narrationOccurrences: Partial<Record<SpeechIntent, number>> = {};

  constructor(
    readonly sessionId: string,
    readonly aiAvailable: boolean,
    readonly liveAvailabilityReason?: string,
  ) {}

  startCall(scenarioId: string, mode: DemoMode): void {
    this.lastActiveAt = Date.now();
    this.callTimestamps.push(Date.now());
    this.workflow.stop?.();
    this.workflow = newWorkflowActor();
    this.scenarioId = mode === "live" ? "live_exploration" : scenarioById(scenarioId).id;
    this.mode = mode;
    this.callId = `call_${randomUUID()}`;
    this.voiceMode = "processing";
    this.transcript = [];
    this.partialTranscript = "";
    this.toolCalls = [];
    this.metrics = {};
    this.reservation = undefined;
    this.options = [];
    this.selectedOption = undefined;
    this.quoteToken = undefined;
    this.outcome = undefined;
    this.escalationReasons = [];
    this.handoffSummary = undefined;
    this.startedAt = new Date().toISOString();
    this.endedAt = undefined;
    this.agentPrompt = undefined;
    this.identity = {};
    this.requestedDates = {};
    this.repairCounts = {};
    this.offTopicCount = 0;
    this.firstPartialAtMs = undefined;
    this.turnStartedAtMs = undefined;
    this.stateHistory = ["idle"];
    this.narrationOccurrences = {};
    this.send({ type: "START" });
  }

  send(event: WorkflowEvent): void {
    this.workflow.send(event);
    this.stateHistory.push(workflowState(this.workflow));
    this.lastActiveAt = Date.now();
  }

  addTurn(
    role: TranscriptTurn["role"],
    text: string,
    final = true,
    narration?: SpeechRenderTrace,
  ): TranscriptTurn {
    const turn: TranscriptTurn = {
      id: `turn_${randomUUID()}`,
      role,
      text,
      at: new Date().toISOString(),
      final,
      narration,
    };
    this.transcript.push(turn);
    this.lastActiveAt = Date.now();
    return turn;
  }

  beginTurn(): void {
    this.turnStartedAtMs = performance.now();
    this.firstPartialAtMs = undefined;
  }

  notePartial(text: string): void {
    this.partialTranscript = text;
    if (!this.firstPartialAtMs && this.turnStartedAtMs) {
      this.firstPartialAtMs = performance.now();
      this.metrics.sttFirstPartialMs = Math.round(this.firstPartialAtMs - this.turnStartedAtMs);
    }
  }

  completeTranscript(text: string): TranscriptTurn {
    if (this.turnStartedAtMs) this.metrics.sttFinalMs = Math.round(performance.now() - this.turnStartedAtMs);
    this.partialTranscript = "";
    return this.addTurn("caller", text);
  }

  incrementRepair(key: string): number {
    this.repairCounts[key] = (this.repairCounts[key] ?? 0) + 1;
    return this.repairCounts[key];
  }

  nextNarrationOccurrence(intent: SpeechIntent): number {
    const occurrence = (this.narrationOccurrences[intent] ?? 0) + 1;
    this.narrationOccurrences[intent] = occurrence;
    return occurrence;
  }

  complete(outcome: CallOutcome): void {
    if (!this.callId || this.outcome) return;
    this.outcome = outcome;
    this.endedAt = new Date().toISOString();
    const durationMs = this.startedAt ? Date.now() - Date.parse(this.startedAt) : 0;
    this.metrics.callTotalMs = durationMs;
    if (workflowState(this.workflow) !== "ended") this.send({ type: "FINISH" });
    this.voiceMode = "ended";
    this.history.unshift({
      callId: this.callId,
      scenarioId: this.scenarioId,
      mode: this.mode,
      outcome,
      escalationReasons: [...this.escalationReasons],
      startedAt: this.startedAt ?? this.endedAt,
      endedAt: this.endedAt,
      durationMs,
      toolCount: this.toolCalls.length,
    });
  }

  resetAll(scenarioId = "happy_exact"): void {
    this.reservationTool.reset();
    this.history = [];
    this.workflow.stop?.();
    this.workflow = newWorkflowActor();
    this.scenarioId = scenarioById(scenarioId).id;
    this.mode = this.aiAvailable ? "live" : "playback";
    this.voiceMode = "idle";
    this.callId = undefined;
    this.transcript = [];
    this.partialTranscript = "";
    this.toolCalls = [];
    this.metrics = {};
    this.reservation = undefined;
    this.options = [];
    this.selectedOption = undefined;
    this.quoteToken = undefined;
    this.outcome = undefined;
    this.escalationReasons = [];
    this.handoffSummary = undefined;
    this.startedAt = undefined;
    this.endedAt = undefined;
    this.agentPrompt = undefined;
    this.identity = {};
    this.requestedDates = {};
    this.repairCounts = {};
    this.offTopicCount = 0;
    this.firstPartialAtMs = undefined;
    this.turnStartedAtMs = undefined;
    this.callTimestamps = [];
    this.stateHistory = ["idle"];
    this.narrationOccurrences = {};
    this.lastActiveAt = Date.now();
  }

  snapshot(): CallSnapshot {
    return {
      sessionId: this.sessionId,
      callId: this.callId,
      scenarioId: this.scenarioId,
      mode: this.mode,
      aiAvailable: this.aiAvailable,
      liveAvailabilityReason: this.liveAvailabilityReason,
      state: workflowState(this.workflow),
      voiceMode: this.voiceMode,
      transcript: structuredClone(this.transcript),
      partialTranscript: this.partialTranscript,
      toolCalls: structuredClone(this.toolCalls),
      metrics: { ...this.metrics },
      reservation: this.reservation ? structuredClone(this.reservation) : undefined,
      options: structuredClone(this.options),
      selectedOption: this.selectedOption ? structuredClone(this.selectedOption) : undefined,
      outcome: this.outcome,
      escalationReasons: [...this.escalationReasons],
      handoffSummary: this.handoffSummary ? structuredClone(this.handoffSummary) : undefined,
      history: structuredClone(this.history),
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      agentPrompt: this.agentPrompt,
    };
  }
}

export class SessionStore {
  private sessions = new Map<string, CallSession>();
  private readonly ttlMs = Number(process.env.SESSION_TTL_MINUTES ?? 60) * 60_000;

  constructor(private readonly aiAvailable: boolean) {
    const timer = setInterval(() => this.cleanup(), Math.min(this.ttlMs, 60_000));
    timer.unref();
  }

  create(): CallSession {
    const session = new CallSession(
      `session_${randomUUID()}`,
      this.aiAvailable,
      this.aiAvailable ? undefined : "No OPENAI_API_KEY is configured. Scenario Playback remains available.",
    );
    session.resetAll();
    this.sessions.set(session.sessionId, session);
    return session;
  }

  get(id: string): CallSession | undefined {
    const session = this.sessions.get(id);
    if (session) session.lastActiveAt = Date.now();
    return session;
  }

  private cleanup(): void {
    const cutoff = Date.now() - this.ttlMs;
    for (const [id, session] of this.sessions) {
      if (session.lastActiveAt < cutoff) this.sessions.delete(id);
    }
  }
}
