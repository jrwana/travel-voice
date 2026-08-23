import { z } from "zod";

export const conversationStates = [
  "idle",
  "greeting",
  "identifying",
  "reservation_ready",
  "collecting_dates",
  "quoting",
  "presenting_options",
  "awaiting_selection",
  "awaiting_confirmation",
  "applying_change",
  "confirmed",
  "escalated",
  "unsupported",
  "ended",
] as const;
export type ConversationState = (typeof conversationStates)[number];

export const voiceModes = ["idle", "listening", "processing", "speaking", "ended"] as const;
export type VoiceMode = (typeof voiceModes)[number];

export const callOutcomes = ["changed", "escalated", "unsupported", "abandoned", "failed"] as const;
export type CallOutcome = (typeof callOutcomes)[number];

export const escalationReasons = [
  "payment_dispute",
  "cancellation_penalty",
  "urgent_disruption",
  "uncertainty",
  "tool_failure",
] as const;
export type EscalationReason = (typeof escalationReasons)[number];

export type DemoMode = "live" | "playback";

export const speechIntents = [
  "greeting",
  "scope_repair",
  "unsupported_end",
  "workflow_recovery",
  "ask_identity",
  "identity_not_found",
  "reservation_found",
  "ask_dates",
  "invalid_dates",
  "present_options",
  "ask_option",
  "ask_confirmation",
  "selection_declined",
  "require_explicit_confirmation",
  "quote_expired",
  "confirm_changed",
  "escalate",
] as const;
export type SpeechIntent = (typeof speechIntents)[number];

export type RenderedBy = "model" | "fixture" | "template";

export interface FidelityViolation {
  category:
    | "unknown_placeholder"
    | "missing_required_fact"
    | "raw_date"
    | "raw_price"
    | "raw_confirmation"
    | "raw_option_count"
    | "raw_room_type"
    | "unmatched_fact"
    | "missing_required_phrase"
    | "malformed_output";
  detail: string;
}

export interface SpeechRenderTrace {
  intent: SpeechIntent;
  renderedBy: RenderedBy;
  latencyMs: number;
  model?: string;
  fixtureKey?: string;
  fallbackReason?: "model_unavailable" | "model_error" | "fixture_missing" | "fidelity_violation";
  fidelity: {
    status: "verified" | "rejected" | "not_run";
    violations: FidelityViolation[];
    candidateText?: string;
    fallbackVerified: boolean;
  };
}

export interface HotelStay {
  hotelName: string;
  city: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  totalPriceCents: number;
  currency: "USD";
}

export interface PublicReservation {
  reservationId: string;
  confirmationCode: string;
  travelerDisplayName: string;
  guests: number;
  status: "confirmed" | "changed";
  stay: HotelStay;
}

export interface ChangeOption {
  optionId: string;
  label: string;
  checkIn: string;
  checkOut: string;
  roomType: string;
  priceDeltaCents: number;
  currency: "USD";
  policySummary: string;
}

export interface TranscriptTurn {
  id: string;
  role: "caller" | "agent" | "system";
  text: string;
  at: string;
  final: boolean;
  narration?: SpeechRenderTrace;
}

export interface ToolCallTrace {
  id: string;
  name: "manage_reservation";
  action: "find" | "quote_date_change" | "confirm_date_change";
  status: "running" | "success" | "error";
  arguments: Record<string, unknown>;
  result?: Record<string, unknown>;
  errorCode?: string;
  startedAt: string;
  durationMs?: number;
}

export interface LatencyMetrics {
  sttFirstPartialMs?: number;
  sttFinalMs?: number;
  llmMs?: number;
  interpretationBy?: "model" | "deterministic";
  narrationMs?: number;
  narrationBy?: RenderedBy;
  toolMs?: number;
  ttsMs?: number;
  turnTotalMs?: number;
  callTotalMs?: number;
}

export interface HandoffSummary {
  queueLabel: string;
  reasons: EscalationReason[];
  traveler?: string;
  confirmationCode?: string;
  requestSummary: string;
  lastCallerTurn: string;
}

export interface CallHistoryItem {
  callId: string;
  scenarioId: string;
  mode: DemoMode;
  outcome: CallOutcome;
  escalationReasons: EscalationReason[];
  startedAt: string;
  endedAt: string;
  durationMs: number;
  toolCount: number;
}

export interface CallSnapshot {
  sessionId: string;
  callId?: string;
  scenarioId: string;
  mode: DemoMode;
  aiAvailable: boolean;
  liveAvailabilityReason?: string;
  state: ConversationState;
  voiceMode: VoiceMode;
  transcript: TranscriptTurn[];
  partialTranscript: string;
  toolCalls: ToolCallTrace[];
  metrics: LatencyMetrics;
  reservation?: PublicReservation;
  options: ChangeOption[];
  selectedOption?: ChangeOption;
  outcome?: CallOutcome;
  escalationReasons: EscalationReason[];
  handoffSummary?: HandoffSummary;
  history: CallHistoryItem[];
  startedAt?: string;
  endedAt?: string;
  agentPrompt?: string;
}

export interface ScenarioTurn {
  caller: string;
  expectState?: ConversationState;
}

export interface DemoScenario {
  id: string;
  shortLabel: string;
  title: string;
  persona: string;
  confirmationCode: string;
  lastName: string;
  goal: string;
  accent: string;
  expectedOutcome: CallOutcome;
  expectedReasons: EscalationReason[];
  turns: ScenarioTurn[];
}

export const clientMessageSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("call.start"), scenarioId: z.string(), mode: z.enum(["live", "playback"]) }),
  z.object({ type: z.literal("call.end") }),
  z.object({ type: z.literal("audio.chunk"), audio: z.string().max(256_000) }),
  z.object({ type: z.literal("text.turn"), text: z.string().trim().min(1).max(1_000) }),
  z.object({
    type: z.literal("identity.correct"),
    confirmationCode: z.string().trim().max(32),
    lastName: z.string().trim().max(80),
  }),
  z.object({
    type: z.literal("dates.correct"),
    checkIn: z.string().date(),
    checkOut: z.string().date(),
  }),
  z.object({ type: z.literal("session.reset"), scenarioId: z.string().optional() }),
  z.object({ type: z.literal("scenario.play"), scenarioId: z.string() }),
]);
export type ClientMessage = z.infer<typeof clientMessageSchema>;

export type ServerEvent =
  | { type: "session.ready"; snapshot: CallSnapshot }
  | { type: "snapshot"; snapshot: CallSnapshot }
  | { type: "transcript.partial"; text: string }
  | { type: "transcript.final"; turn: TranscriptTurn }
  | { type: "agent.message"; turn: TranscriptTurn; audioBase64?: string; audioMimeType?: string }
  | { type: "notice"; level: "info" | "warning" | "error"; message: string }
  | { type: "scenario.complete"; scenarioId: string; passed: boolean; assertions: string[] };

export interface BootstrapResponse {
  sessionId: string;
  scenarios: DemoScenario[];
  snapshot: CallSnapshot;
  limits: {
    maxCallSeconds: number;
    maxConcurrentCalls: number;
    maxDailyCalls: number;
  };
}
