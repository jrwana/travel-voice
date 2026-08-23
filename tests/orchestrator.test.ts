import { describe, expect, it } from "vitest";
import type { ServerEvent } from "../src/shared/contracts.js";
import { demoScenarios } from "../src/shared/scenarios.js";
import { workflowState } from "../server/domain/workflow.js";
import { Orchestrator } from "../server/orchestrator.js";
import { CallSession } from "../server/session.js";
import { AgentService } from "../server/services/agent.js";

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
