import type { ServerEvent } from "../src/shared/contracts.js";
import { demoScenarios } from "../src/shared/scenarios.js";
import { workflowState } from "../server/domain/workflow.js";
import { Orchestrator } from "../server/orchestrator.js";
import { CallSession } from "../server/session.js";
import { AgentService } from "../server/services/agent.js";

const orchestrator = new Orchestrator(new AgentService(""));
const rows: Array<Record<string, string | number>> = [];
let failed = false;

for (const scenario of demoScenarios) {
  const session = new CallSession(`eval_${scenario.id}`, false, "deterministic evaluation");
  const emit = (_event: ServerEvent) => undefined;
  const stateAssertions: boolean[] = [];
  await orchestrator.startCall(session, scenario.id, "playback", emit);
  for (const turn of scenario.turns) {
    await orchestrator.handleCallerText(session, turn.caller, emit);
    stateAssertions.push(!turn.expectState || workflowState(session.workflow) === turn.expectState);
    if (session.outcome) break;
  }

  const passed =
    stateAssertions.every(Boolean) &&
    session.outcome === scenario.expectedOutcome &&
    scenario.expectedReasons.every((reason) => session.escalationReasons.includes(reason));
  failed ||= !passed;
  rows.push({
    scenario: scenario.id,
    result: passed ? "PASS" : "FAIL",
    outcome: session.outcome ?? "none",
    tools: session.toolCalls.length,
    turns: session.transcript.filter((turn) => turn.role === "caller").length,
    reasons: session.escalationReasons.join(", ") || "—",
  });
}

console.table(rows);
if (failed) process.exitCode = 1;
