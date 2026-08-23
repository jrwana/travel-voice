import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import OpenAI from "openai";
import { z } from "zod";
import type {
  ChangeOption,
  EscalationReason,
  FidelityViolation,
  RenderedBy,
  SpeechIntent,
  SpeechRenderTrace,
} from "../../src/shared/contracts.js";
import { consoleServiceLogger, type ServiceLogger } from "./logger.js";

type NoFacts = Record<string, never>;

export interface SpeechFactsByIntent {
  greeting: { agencyName: string };
  scope_repair: { supportedScope: string };
  unsupported_end: NoFacts;
  workflow_recovery: NoFacts;
  ask_identity: NoFacts;
  identity_not_found: NoFacts;
  reservation_found: { hotelName: string; city: string; checkIn: string; checkOut: string };
  ask_dates: NoFacts;
  invalid_dates: NoFacts;
  present_options: { options: ChangeOption[] };
  ask_option: NoFacts;
  ask_confirmation: { option: ChangeOption };
  selection_declined: NoFacts;
  require_explicit_confirmation: NoFacts;
  quote_expired: NoFacts;
  confirm_changed: {
    hotelName: string;
    checkIn: string;
    checkOut: string;
    mockConfirmationNumber: string;
  };
  escalate: { reasons: EscalationReason[]; queueLabel: string };
}

export interface NarrationContext {
  live: boolean;
  scenarioId: string;
  occurrence: number;
}

export interface NarrationResult {
  text: string;
  renderedBy: RenderedBy;
  trace: SpeechRenderTrace;
}

export interface NarrationFixtureEntry {
  key: string;
  scenarioId: string;
  intent: SpeechIntent;
  occurrence: number;
  candidateText: string;
}

export interface NarrationFixtureFile {
  schemaVersion: 1;
  recordedAt: string;
  provider: string;
  model: string;
  entries: NarrationFixtureEntry[];
}

interface Binding {
  value: string;
  description: string;
}

interface BindingSet {
  bindings: Record<string, Binding>;
  requiredKeys: string[];
  requiredPhrases: string[];
}

export interface FidelityResult {
  passed: boolean;
  violations: FidelityViolation[];
}

export type NarrationGenerator = (request: {
  intent: SpeechIntent;
  prompt: string;
  model: string;
}) => Promise<string>;

export interface NarratorOptions {
  apiKey?: string;
  baseURL?: string;
  model?: string;
  logger?: ServiceLogger;
  fixtureStore?: NarrationFixtureStore;
  generator?: NarrationGenerator;
}

const fixtureEntrySchema = z.object({
  key: z.string().min(1),
  scenarioId: z.string().min(1),
  intent: z.enum([
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
  ]),
  occurrence: z.number().int().positive(),
  candidateText: z.string().min(1),
});

const fixtureFileSchema = z.object({
  schemaVersion: z.literal(1),
  recordedAt: z.string(),
  provider: z.string(),
  model: z.string(),
  entries: z.array(fixtureEntrySchema),
});

const monthPattern =
  /\b(?:january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+20\d{2})?\b/gi;
const isoDatePattern = /\b20\d{2}-\d{2}-\d{2}\b/g;
const pricePattern =
  /(?:\$\s?\d[\d,]*(?:\.\d{1,2})?|\b\d[\d,]*(?:\.\d{1,2})?\s*(?:usd|dollars?|cents?)\b|\b(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand)(?:[ -](?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|twenty|thirty|forty|fifty|hundred|thousand))*\s+(?:dollars?|cents?)\b)/gi;
const confirmationPattern = /\b(?:MPT|MPC)[ -]?[A-Z0-9]{4,}\b/gi;
const optionCountPattern = /\b(?:one|two|three|four|five|six|seven|eight|nine|ten|\d+)\s+(?:mock\s+)?options?\b/gi;
const optionLabelPattern = /\boption\s+\d+\b/gi;
const optionEnumeratorPattern = /(?<![\d.$])\b\d+\)/g;
const roomTypePattern = /\b(?:[a-z][a-z'-]*\s+){0,3}(?:king|queen|suite|twin|double|single)\b/gi;
const placeholderPattern = /{{([a-z0-9_]+)}}/g;

export function narrationFixtureKey(scenarioId: string, intent: SpeechIntent, occurrence: number): string {
  return scenarioId + ":" + intent + ":" + occurrence;
}

export class NarrationFixtureStore {
  private readonly entries: Map<string, NarrationFixtureEntry>;

  constructor(
    readonly metadata: Pick<NarrationFixtureFile, "provider" | "model" | "recordedAt"> | undefined,
    entries: NarrationFixtureEntry[],
  ) {
    this.entries = new Map(entries.map((entry) => [entry.key, entry]));
  }

  static empty(): NarrationFixtureStore {
    return new NarrationFixtureStore(undefined, []);
  }

  static load(filePath = path.resolve(process.cwd(), "tests/fixtures/narration.json")): NarrationFixtureStore {
    if (!existsSync(filePath)) return NarrationFixtureStore.empty();
    const parsed = fixtureFileSchema.parse(JSON.parse(readFileSync(filePath, "utf8"))) as NarrationFixtureFile;
    return new NarrationFixtureStore(
      { provider: parsed.provider, model: parsed.model, recordedAt: parsed.recordedAt },
      parsed.entries,
    );
  }

  get(scenarioId: string, intent: SpeechIntent, occurrence: number): NarrationFixtureEntry | undefined {
    return this.entries.get(narrationFixtureKey(scenarioId, intent, occurrence));
  }

  all(): NarrationFixtureEntry[] {
    return [...this.entries.values()];
  }
}

function formatDate(iso: string): string {
  return new Intl.DateTimeFormat("en-US", {
    month: "long",
    day: "numeric",
    year: "numeric",
    timeZone: "UTC",
  }).format(new Date(iso + "T00:00:00.000Z"));
}

function formatDelta(cents: number): string {
  if (cents === 0) return "with no price difference";
  const amount = new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(
    Math.abs(cents) / 100,
  );
  return cents > 0 ? "for " + amount + " more" : "saving " + amount;
}

function describeReasons(reasons: EscalationReason[]): string {
  const labels: Record<EscalationReason, string> = {
    payment_dispute: "a payment dispute",
    cancellation_penalty: "a cancellation penalty",
    urgent_disruption: "an urgent travel disruption",
    uncertainty: "unresolved uncertainty",
    tool_failure: "a reservation tool failure",
  };
  return reasons.map((reason) => labels[reason]).join(" and ");
}

function binding(value: string, description: string): Binding {
  return { value, description };
}

function numberWord(value: number): string {
  const values = ["zero", "one", "two", "three", "four", "five", "six", "seven", "eight", "nine", "ten"];
  return values[value] ?? String(value);
}

function optionBindings(option: ChangeOption, index: number): Record<string, Binding> {
  const number = index + 1;
  const prefix = "option_" + number + "_";
  return {
    [prefix + "label"]: binding("Option " + number, "label for available option " + number),
    [prefix + "check_in"]: binding(formatDate(option.checkIn), "check-in date for option " + number),
    [prefix + "check_out"]: binding(formatDate(option.checkOut), "check-out date for option " + number),
    [prefix + "room_type"]: binding(option.roomType, "room type for option " + number),
    [prefix + "price"]: binding(
      formatDelta(option.priceDeltaCents),
      "complete price-difference phrase for option " + number + "; place after a comma with no added preposition",
    ),
  };
}

function speechGoal(intent: SpeechIntent): string {
  switch (intent) {
    case "greeting":
      return "Start with Hello. Introduce {{agency_name}} as a fictional AI demo using synthetic reservations, state that it only supports hotel-date changes and cannot make a real booking or charge, then ask for the confirmation code and last name.";
    case "scope_repair":
      return "State that this demo supports only {{supported_scope}}, then guide the caller back to providing their confirmation code and last name or continuing that date change.";
    case "unsupported_end":
      return "Say the request is outside this demo's scope and end the call safely without claiming that any external action occurred.";
    case "workflow_recovery":
      return "Ask the caller to wait briefly while the deterministic demo workflow returns to a safe state.";
    case "ask_identity":
      return "Ask for both the reservation confirmation code and the last name.";
    case "identity_not_found":
      return "Say the supplied details did not match a synthetic reservation and ask for the confirmation code and last name one more time.";
    case "reservation_found":
      return "Say that you found a synthetic reservation for {{hotel_name}} in {{city}} from {{current_check_in}} to {{current_check_out}}, then ask for the new check-in and check-out dates. Never call the reservation confirmed.";
    case "ask_dates":
      return "Ask for both the new check-in and check-out dates.";
    case "invalid_dates":
      return "Explain only that check-out must be after check-in and ask for both dates again; do not make an availability claim.";
    case "present_options":
      return "Present all {{option_count}} mock options in order using every supplied option placeholder, then ask which option the caller wants. Option-label placeholders already contain numbering. Each option-price placeholder is a complete modifier: put a comma immediately before it and do not add a preposition. Do not add numbered list markers.";
    case "ask_option":
      return "Ask the caller to choose the first, second, or third option.";
    case "ask_confirmation":
      return "Use this exact recap frame so the complete price phrase stays grammatical: 'To recap: {{selected_check_in}} to {{selected_check_out}}, {{selected_room_type}}, {{selected_price}}.' Then say exactly 'This is a fictional mock change. Please confirm with yes or no. No payment will occur.'";
    case "selection_declined":
      return "State that no change was made and ask the caller to choose among the three options again.";
    case "require_explicit_confirmation":
      return "State that the mock change requires an explicit yes, while allowing the caller to say no.";
    case "quote_expired":
      return "State that the mock quote expired and that the deterministic demo will refresh the options before asking for confirmation again.";
    case "confirm_changed":
      return "State that the fictional stay at {{hotel_name}} changed to {{changed_check_in}} through {{changed_check_out}}, provide mock confirmation {{mock_confirmation}}, and make clear that no real booking or payment occurred.";
    case "escalate":
      return "Use status-only language. Say exactly that 'This request involves {{escalation_reasons}} and needs a human travel specialist.' Then say that 'A summary was prepared for a simulated handoff.' Finally state that no reservation or payment changed. You may add warmth, but never claim that any person is ready, available, handling the request, or will perform an action.";
  }
}

function forbiddenClaims(intent: SpeechIntent, text: string): FidelityViolation[] {
  const rules: Array<{ pattern: RegExp; detail: string }> = [];
  if (intent === "greeting") {
    rules.push(
      {
        pattern: /\b(?:good\s+)?(?:morning|afternoon|evening)\b/i,
        detail: "Greeting invented a time of day.",
      },
      {
        pattern: /\ball (?:of )?(?:your )?synthetic reservations\b/i,
        detail: "Greeting overclaimed access to every synthetic reservation.",
      },
      {
        pattern: /\bgood day\b/i,
        detail: "Greeting used a time-dependent salutation.",
      },
    );
  }
  if (intent === "invalid_dates") {
    rules.push({
      pattern: /\b(?:not available|unavailable|sold out)\b/i,
      detail: "Invalid-date response invented an availability result.",
    });
  }
  if (intent === "reservation_found") {
    rules.push({
      pattern: /\b(?:confirm(?:ed|ing)?|changed|cancelled|canceled)\b/i,
      detail: "Reservation lookup response implied a confirmation or mutation.",
    });
  }
  if (intent === "escalate") {
    rules.push({
      pattern: /\b(?:arrang(?:e|ed|ing)|assist(?:ed|ing)?|connect(?:ing|ed)?|handl(?:e|ed|ing)|transfer(?:ring|red)?|forward(?:ing|ed)?|pass(?:ing|ed)?|send(?:ing|sent)?|rout(?:e|ing|ed)|hand(?:ing|ed)|plac(?:e|ed|ing)|enter(?:ing|ed)?|add(?:ed|ing)|ready\s+to|available\s+to|will)\b/i,
      detail: "Escalation response claimed that a real handoff or queue action occurred.",
    });
    rules.push({
      pattern: /\bmy friend\b/i,
      detail: "Escalation response used an inappropriate term of endearment.",
    });
  }

  return rules
    .filter((rule) => rule.pattern.test(text))
    .map((rule) => ({ category: "malformed_output", detail: rule.detail }));
}

function bindingSet<I extends SpeechIntent>(intent: I, facts: SpeechFactsByIntent[I]): BindingSet {
  switch (intent) {
    case "greeting": {
      const value = facts as SpeechFactsByIntent["greeting"];
      return {
        bindings: { agency_name: binding(value.agencyName, "fictional travel agency name") },
        requiredKeys: ["agency_name"],
        requiredPhrases: [
          "Hello",
          "AI assistant",
          "synthetic reservations",
          "cannot make a real booking or charge",
          "hotel-date changes",
          "confirmation code",
          "last name",
        ],
      };
    }
    case "scope_repair": {
      const value = facts as SpeechFactsByIntent["scope_repair"];
      return {
        bindings: { supported_scope: binding(value.supportedScope, "the only supported task") },
        requiredKeys: ["supported_scope"],
        requiredPhrases: [],
      };
    }
    case "reservation_found": {
      const value = facts as SpeechFactsByIntent["reservation_found"];
      return {
        bindings: {
          hotel_name: binding(value.hotelName, "hotel name"),
          city: binding(value.city, "hotel city"),
          current_check_in: binding(formatDate(value.checkIn), "current check-in date"),
          current_check_out: binding(formatDate(value.checkOut), "current check-out date"),
        },
        requiredKeys: ["hotel_name", "city", "current_check_in", "current_check_out"],
        requiredPhrases: ["found a synthetic reservation", "new check-in and check-out dates"],
      };
    }
    case "present_options": {
      const value = facts as SpeechFactsByIntent["present_options"];
      const bindings = Object.assign(
        { option_count: binding(numberWord(value.options.length), "number of available mock options") },
        ...value.options.map(optionBindings),
      ) as Record<string, Binding>;
      return {
        bindings,
        requiredKeys: Object.keys(bindings),
        requiredPhrases: [
          "mock options",
          "Which option",
          ", {{option_1_price}}",
          ", {{option_2_price}}",
          ", {{option_3_price}}",
        ],
      };
    }
    case "ask_confirmation": {
      const value = facts as SpeechFactsByIntent["ask_confirmation"];
      return {
        bindings: {
          selected_check_in: binding(formatDate(value.option.checkIn), "selected check-in date"),
          selected_check_out: binding(formatDate(value.option.checkOut), "selected check-out date"),
          selected_room_type: binding(value.option.roomType, "selected room type"),
          selected_price: binding(
            formatDelta(value.option.priceDeltaCents),
            "complete selected price-difference phrase; place after a comma with no added preposition",
          ),
        },
        requiredKeys: ["selected_check_in", "selected_check_out", "selected_room_type", "selected_price"],
        requiredPhrases: [
          "To recap: {{selected_check_in}} to {{selected_check_out}}, {{selected_room_type}}, {{selected_price}}.",
          "This is a fictional mock change.",
          "Please confirm with yes or no.",
          "No payment will occur.",
        ],
      };
    }
    case "confirm_changed": {
      const value = facts as SpeechFactsByIntent["confirm_changed"];
      return {
        bindings: {
          hotel_name: binding(value.hotelName, "hotel name"),
          changed_check_in: binding(formatDate(value.checkIn), "confirmed new check-in date"),
          changed_check_out: binding(formatDate(value.checkOut), "confirmed new check-out date"),
          mock_confirmation: binding(value.mockConfirmationNumber, "mock confirmation number"),
        },
        requiredKeys: ["hotel_name", "changed_check_in", "changed_check_out", "mock_confirmation"],
        requiredPhrases: ["Your mock confirmation is", "No real booking or payment was made"],
      };
    }
    case "escalate": {
      const value = facts as SpeechFactsByIntent["escalate"];
      return {
        bindings: {
          escalation_reasons: binding(describeReasons(value.reasons), "deterministic escalation reasons"),
        },
        requiredKeys: ["escalation_reasons"],
        requiredPhrases: [
          "This request involves {{escalation_reasons}} and needs a human travel specialist",
          "A summary was prepared for a simulated handoff",
          "No reservation or payment was changed",
        ],
      };
    }
    case "ask_identity":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["confirmation code", "last name"] };
    case "identity_not_found":
      return {
        bindings: {},
        requiredKeys: [],
        requiredPhrases: ["synthetic reservation", "confirmation code", "last name", "one more time"],
      };
    case "ask_dates":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["check-in", "check-out"] };
    case "invalid_dates":
      return {
        bindings: {},
        requiredKeys: [],
        requiredPhrases: ["Check-out must be after check-in"],
      };
    case "ask_option":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["first, second, or third option"] };
    case "selection_declined":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["No change was made"] };
    case "require_explicit_confirmation":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["explicit yes"] };
    case "quote_expired":
      return { bindings: {}, requiredKeys: [], requiredPhrases: ["expired", "refresh"] };
    default:
      return { bindings: {}, requiredKeys: [], requiredPhrases: [] };
  }
}

export function templateFor<I extends SpeechIntent>(intent: I, facts: SpeechFactsByIntent[I]): string {
  switch (intent) {
    case "greeting":
      return "Hello, you've reached Meridian and Pine Travel. I'm an AI assistant in a fictional demo using synthetic reservations. I can help change hotel dates, but I cannot make a real booking or charge. Please share your confirmation code and last name.";
    case "scope_repair":
      return "I can only help with a fictional hotel-date change in this demo. Please share your confirmation code and last name, or continue with the date change.";
    case "unsupported_end":
      return "I can't help with that request, so I'll end this demo call safely.";
    case "workflow_recovery":
      return "One moment while I keep this demo call in a safe workflow state.";
    case "ask_identity":
      return "I need both the confirmation code and the last name on the reservation.";
    case "identity_not_found":
      return "I couldn't match those details. Please try the confirmation code and last name one more time.";
    case "reservation_found": {
      const value = facts as SpeechFactsByIntent["reservation_found"];
      return "I found " + value.hotelName + " in " + value.city + ", from " + formatDate(value.checkIn) +
        " to " + formatDate(value.checkOut) + ". What new check-in and check-out dates would you like?";
    }
    case "ask_dates":
      return "Please give me both the new check-in and check-out dates.";
    case "invalid_dates":
      return "Those dates don't form a valid stay. Check-out must be after check-in. Please try both dates again.";
    case "present_options": {
      const value = facts as SpeechFactsByIntent["present_options"];
      const options = value.options.map((option, index) =>
        "Option " + (index + 1) + ": " + formatDate(option.checkIn) + " to " + formatDate(option.checkOut) +
        ", " + option.roomType + ", " + formatDelta(option.priceDeltaCents)
      ).join(". ");
      return "I found three mock options. " + options + ". Which option would you like?";
    }
    case "ask_option":
      return "Please say first, second, or third option.";
    case "ask_confirmation": {
      const value = facts as SpeechFactsByIntent["ask_confirmation"];
      const option = value.option;
      return "To recap: " + formatDate(option.checkIn) + " to " + formatDate(option.checkOut) + ", " +
        option.roomType + ", " + formatDelta(option.priceDeltaCents) +
        ". This is fictional and no payment will occur. Would you like me to confirm this mock change?";
    }
    case "selection_declined":
      return "No change was made. Please choose the first, second, or third option.";
    case "require_explicit_confirmation":
      return "I need an explicit yes to confirm this mock change, or you can say no.";
    case "quote_expired":
      return "That mock quote expired. I'll refresh the three options before asking you to confirm again.";
    case "confirm_changed": {
      const value = facts as SpeechFactsByIntent["confirm_changed"];
      return "Your fictional stay at " + value.hotelName + " is now changed to " + formatDate(value.checkIn) +
        " through " + formatDate(value.checkOut) + ". Your mock confirmation is " +
        value.mockConfirmationNumber + ". No real booking or payment was made.";
    }
    case "escalate":
      return "This request needs a human travel specialist. I've stopped the automated workflow and prepared a summary for a simulated handoff. No reservation or payment was changed.";
  }
}

function collectMatches(text: string, pattern: RegExp): string[] {
  pattern.lastIndex = 0;
  return [...text.matchAll(pattern)].map((match) => match[0]);
}

function rawCandidateViolations(text: string): FidelityViolation[] {
  const checks: Array<[FidelityViolation["category"], RegExp, string]> = [
    ["raw_date", monthPattern, "date"],
    ["raw_date", isoDatePattern, "ISO date"],
    ["raw_price", pricePattern, "price"],
    ["raw_confirmation", confirmationPattern, "confirmation code"],
    ["raw_option_count", optionCountPattern, "option count"],
    ["raw_option_count", optionLabelPattern, "numeric option label"],
    ["raw_option_count", optionEnumeratorPattern, "numeric option enumerator"],
    ["raw_room_type", roomTypePattern, "room type"],
  ];
  return checks.flatMap(([category, pattern, label]) =>
    collectMatches(text, pattern).map((match) => ({
      category,
      detail: "Model draft used a raw " + label + " instead of an approved fact placeholder: " + match,
    })),
  );
}

function finalFactMatches(text: string): Array<{ category: FidelityViolation["category"]; value: string }> {
  return [
    ...collectMatches(text, monthPattern).map((value) => ({ category: "raw_date" as const, value })),
    ...collectMatches(text, isoDatePattern).map((value) => ({ category: "raw_date" as const, value })),
    ...collectMatches(text, pricePattern).map((value) => ({ category: "raw_price" as const, value })),
    ...collectMatches(text, confirmationPattern).map((value) => ({
      category: "raw_confirmation" as const,
      value,
    })),
    ...collectMatches(text, optionCountPattern).map((value) => ({
      category: "raw_option_count" as const,
      value,
    })),
    ...collectMatches(text, optionLabelPattern).map((value) => ({
      category: "raw_option_count" as const,
      value,
    })),
    ...collectMatches(text, optionEnumeratorPattern).map((value) => ({
      category: "raw_option_count" as const,
      value,
    })),
    ...collectMatches(text, roomTypePattern).map((value) => ({ category: "raw_room_type" as const, value })),
  ];
}

function valueTracesToBinding(match: string, values: string[]): boolean {
  const normalized = match.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
  return values.some((value) => {
    const candidate = value.toLocaleLowerCase("en-US").replace(/\s+/g, " ").trim();
    return candidate.includes(normalized) || normalized.includes(candidate);
  });
}

function verifyFinalText(text: string, set: BindingSet): FidelityResult {
  const values = Object.values(set.bindings).map((entry) => entry.value);
  const violations = finalFactMatches(text)
    .filter((match) => !valueTracesToBinding(match.value, values))
    .map<FidelityViolation>((match) => ({
      category: "unmatched_fact",
      detail: "Rendered fact does not trace to supplied values: " + match.value,
    }));
  return { passed: violations.length === 0, violations };
}

export function verifyFactFidelity<I extends SpeechIntent>(
  intent: I,
  facts: SpeechFactsByIntent[I],
  candidateText: string,
): FidelityResult {
  const set = bindingSet(intent, facts);
  const violations: FidelityViolation[] = [];
  const trimmed = candidateText.trim();
  if (
    !trimmed ||
    trimmed.length > 1_200 ||
    trimmed.includes(String.fromCharCode(96).repeat(3)) ||
    /^\s*[{\[]/.test(trimmed) ||
    /,\s*,/.test(trimmed)
  ) {
    violations.push({ category: "malformed_output", detail: "Narration must be plain caller-facing text." });
  }
  const keys = [...trimmed.matchAll(placeholderPattern)].map((match) => match[1]);
  for (const match of trimmed.matchAll(/<([a-z_]+)>/gi)) {
    violations.push({
      category: "unknown_placeholder",
      detail: "Unknown angle-bracket placeholder: " + match[0],
    });
  }
  for (const key of keys) {
    if (!set.bindings[key]) {
      violations.push({ category: "unknown_placeholder", detail: "Unknown fact placeholder: {{" + key + "}}" });
    }
  }
  for (const key of set.requiredKeys) {
    if (!keys.includes(key)) {
      violations.push({ category: "missing_required_fact", detail: "Required fact was omitted: {{" + key + "}}" });
    }
  }
  for (const phrase of set.requiredPhrases) {
    if (!trimmed.toLocaleLowerCase("en-US").includes(phrase.toLocaleLowerCase("en-US"))) {
      violations.push({ category: "missing_required_phrase", detail: "Required safety phrase was omitted: " + phrase });
    }
  }
  violations.push(...rawCandidateViolations(trimmed));
  const forbidden = forbiddenClaims(intent, trimmed);
  violations.push(...forbidden);
  if (violations.length) return { passed: false, violations };

  const hydrated = trimmed.replace(placeholderPattern, (_match, key: string) => set.bindings[key]?.value ?? "");
  return verifyFinalText(hydrated, set);
}

function hydrate<I extends SpeechIntent>(intent: I, facts: SpeechFactsByIntent[I], candidateText: string): string {
  const set = bindingSet(intent, facts);
  return candidateText.trim().replace(placeholderPattern, (_match, key: string) => set.bindings[key]?.value ?? "");
}

function modelPrompt<I extends SpeechIntent>(intent: I, facts: SpeechFactsByIntent[I]): string {
  const set = bindingSet(intent, facts);
  const placeholder = (key: string) => "{{" + key + "}}";
  const slots = Object.entries(set.bindings)
    .map(([key, entry]) => "- " + placeholder(key) + ": " + entry.description)
    .join("\n");
  const requiredFacts = set.requiredKeys.length
    ? "You must naturally include these placeholders: " + set.requiredKeys.map(placeholder).join(", ") + "."
    : "No fact placeholder is mandatory.";
  const requiredPhrases = set.requiredPhrases.length
    ? "Include these exact phrases: " + set.requiredPhrases.map((phrase) => JSON.stringify(phrase)).join(", ") + "."
    : "";
  return [
    "Write the caller-facing language for the speech act " + intent + ".",
    "Communication goal: " + speechGoal(intent),
    "Use a warm, concise travel-support voice. Return only the spoken line, with no JSON, labels, markdown, or quotation marks.",
    "Decisions are already final. Do not choose an option, confirm a change, decide an escalation, call a tool, add advice, or add any fact.",
    "Use the placeholders below whenever mentioning a date, price, confirmation, option label/count, room type, hotel, city, queue, or escalation reason.",
    "Never spell out or invent the value behind a placeholder. Preserve every placeholder exactly.",
    "Never write a literal date, price, confirmation code, room type, option count, option label, or numbered-list marker; use only the supplied placeholders for those facts.",
    "Your response will be rejected unless every required placeholder and exact phrase appears verbatim.",
    "Do not imply that a real booking, payment, transfer, queue placement, availability search, or external action occurred unless the communication goal explicitly says so.",
    "Do not use a time-of-day greeting.",
    "Do not use terms of endearment or describe yourself as premium.",
    intent === "greeting" ? "Begin with Hello." : "Do not greet the caller again.",
    requiredFacts,
    requiredPhrases,
    slots || "- No dynamic fact placeholders are available for this speech act.",
  ]
    .filter(Boolean)
    .join("\n");
}

export class NarratorService {
  private readonly client?: OpenAI;
  private readonly generator?: NarrationGenerator;
  private readonly model: string;
  private readonly logger: ServiceLogger;
  private readonly fixtures: NarrationFixtureStore;

  constructor(options: NarratorOptions = {}) {
    const apiKey = options.apiKey ?? process.env.NARRATOR_API_KEY ?? process.env.OPENAI_API_KEY;
    const baseURL = options.baseURL ?? process.env.NARRATOR_BASE_URL;
    this.client = !options.generator && apiKey ? new OpenAI({ apiKey, baseURL }) : undefined;
    this.generator = options.generator;
    this.model = options.model ?? process.env.NARRATOR_MODEL ?? process.env.OPENAI_AGENT_MODEL ?? "gpt-5.4-mini";
    this.logger = options.logger ?? consoleServiceLogger;
    this.fixtures = options.fixtureStore ?? NarrationFixtureStore.load();
  }

  get available(): boolean {
    return Boolean(this.client || this.generator);
  }

  async render<I extends SpeechIntent>(
    intent: I,
    facts: SpeechFactsByIntent[I],
    context: NarrationContext,
  ): Promise<NarrationResult> {
    const startedAt = performance.now();
    const fixtureKey = narrationFixtureKey(context.scenarioId, intent, context.occurrence);
    let candidateText: string | undefined;
    let renderedBy: Exclude<RenderedBy, "template"> | undefined;
    let candidateModel: string | undefined;
    let fallbackReason: SpeechRenderTrace["fallbackReason"];

    if (context.live) {
      if (!this.available) {
        fallbackReason = "model_unavailable";
      } else {
        try {
          candidateText = await this.generate(intent, facts);
          renderedBy = "model";
          candidateModel = this.model;
        } catch (error) {
          fallbackReason = "model_error";
          this.logger.error(
            { error: error instanceof Error ? error.message : String(error), intent, model: this.model },
            "Narration model failed; using verified template fallback",
          );
        }
      }
    } else {
      const fixture = this.fixtures.get(context.scenarioId, intent, context.occurrence);
      if (fixture) {
        candidateText = fixture.candidateText;
        renderedBy = "fixture";
        candidateModel = this.fixtures.metadata?.model;
      } else {
        fallbackReason = "fixture_missing";
      }
    }

    if (candidateText && renderedBy) {
      const fidelity = verifyFactFidelity(intent, facts, candidateText);
      if (fidelity.passed) {
        const text = hydrate(intent, facts, candidateText);
        return {
          text,
          renderedBy,
          trace: {
            intent,
            renderedBy,
            latencyMs: Math.round(performance.now() - startedAt),
            model: candidateModel,
            fixtureKey,
            fidelity: {
              status: "verified",
              violations: [],
              candidateText,
              fallbackVerified: true,
            },
          },
        };
      }
      fallbackReason = "fidelity_violation";
      this.logger.warn(
        { intent, renderedBy, violations: fidelity.violations, fixtureKey },
        "Narration failed fact-fidelity verification; using verified template fallback",
      );
      return this.templateFallback(intent, facts, startedAt, fallbackReason, fidelity.violations, candidateText, candidateModel);
    }

    return this.templateFallback(intent, facts, startedAt, fallbackReason, [], undefined, candidateModel);
  }

  private async generate<I extends SpeechIntent>(intent: I, facts: SpeechFactsByIntent[I]): Promise<string> {
    const prompt = modelPrompt(intent, facts);
    if (this.generator) return this.generator({ intent, prompt, model: this.model });
    if (!this.client) throw new Error("Narration model is unavailable");
    const response = await this.client.responses.create({
      model: this.model,
      store: false,
      instructions:
        "You are the language renderer inside a guarded fictional travel-support demo. Phrase only the supplied placeholder-bound facts.",
      input: prompt,
      max_output_tokens: Number(process.env.NARRATOR_MAX_OUTPUT_TOKENS ?? 1600),
    });
    const text = response.output_text.trim();
    if (!text) throw new Error("Narration model returned no output text (" + response.status + ")");
    return text;
  }

  private templateFallback<I extends SpeechIntent>(
    intent: I,
    facts: SpeechFactsByIntent[I],
    startedAt: number,
    fallbackReason: SpeechRenderTrace["fallbackReason"],
    violations: FidelityViolation[],
    candidateText?: string,
    model?: string,
  ): NarrationResult {
    const text = templateFor(intent, facts);
    const fallbackCheck = verifyFinalText(text, bindingSet(intent, facts));
    if (!fallbackCheck.passed) {
      this.logger.error(
        { intent, violations: fallbackCheck.violations },
        "Built-in narration template failed fact-fidelity verification",
      );
      throw new Error("Built-in template failed fact-fidelity verification for " + intent);
    }
    return {
      text,
      renderedBy: "template",
      trace: {
        intent,
        renderedBy: "template",
        latencyMs: Math.round(performance.now() - startedAt),
        model,
        fallbackReason,
        fidelity: {
          status: candidateText ? "rejected" : "not_run",
          violations,
          candidateText,
          fallbackVerified: true,
        },
      },
    };
  }
}
