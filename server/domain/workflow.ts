import { createActor, createMachine, type AnyActorRef } from "xstate";
import type { ConversationState } from "../../src/shared/contracts.js";

export type WorkflowEvent =
  | { type: "START" }
  | { type: "GREETED" }
  | { type: "FOUND" }
  | { type: "REQUEST_DATES" }
  | { type: "DATES_READY" }
  | { type: "INVALID_DATES" }
  | { type: "QUOTED" }
  | { type: "OPTIONS_PRESENTED" }
  | { type: "SELECT" }
  | { type: "CHANGE_DATES" }
  | { type: "CHANGE_SELECTION" }
  | { type: "CONFIRM" }
  | { type: "REQUOTE" }
  | { type: "CHANGED" }
  | { type: "ESCALATE" }
  | { type: "UNSUPPORTED" }
  | { type: "FINISH" };

const terminalTransitions = {
  ESCALATE: { target: "escalated" },
  UNSUPPORTED: { target: "unsupported" },
  FINISH: { target: "ended" },
} as const;

export const workflowMachine = createMachine({
  id: "travel-support",
  types: {} as { events: WorkflowEvent },
  initial: "idle",
  states: {
    idle: { on: { START: "greeting" } },
    greeting: { on: { GREETED: "identifying", ...terminalTransitions } },
    identifying: { on: { FOUND: "reservation_ready", ...terminalTransitions } },
    reservation_ready: { on: { REQUEST_DATES: "collecting_dates", ...terminalTransitions } },
    collecting_dates: { on: { DATES_READY: "quoting", ...terminalTransitions } },
    quoting: { on: { QUOTED: "presenting_options", INVALID_DATES: "collecting_dates", ...terminalTransitions } },
    presenting_options: { on: { OPTIONS_PRESENTED: "awaiting_selection", ...terminalTransitions } },
    awaiting_selection: {
      on: { SELECT: "awaiting_confirmation", CHANGE_DATES: "collecting_dates", ...terminalTransitions },
    },
    awaiting_confirmation: {
      on: {
        CONFIRM: "applying_change",
        CHANGE_DATES: "collecting_dates",
        CHANGE_SELECTION: "awaiting_selection",
        ...terminalTransitions,
      },
    },
    applying_change: { on: { CHANGED: "confirmed", REQUOTE: "quoting", ...terminalTransitions } },
    confirmed: { on: terminalTransitions },
    escalated: { on: { FINISH: "ended" } },
    unsupported: { on: { FINISH: "ended" } },
    ended: { type: "final" },
  },
});

export function newWorkflowActor(): AnyActorRef {
  return createActor(workflowMachine).start();
}

export function workflowState(actor: AnyActorRef): ConversationState {
  return actor.getSnapshot().value as ConversationState;
}
