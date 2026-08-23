import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { ServerEvent } from "../src/shared/contracts.js";
import { demoScenarios } from "../src/shared/scenarios.js";
import { workflowState } from "../server/domain/workflow.js";
import { Orchestrator } from "../server/orchestrator.js";
import { CallSession } from "../server/session.js";
import { AgentService } from "../server/services/agent.js";
import { consoleServiceLogger, silentServiceLogger } from "../server/services/logger.js";
import {
  NarrationFixtureStore,
  NarratorService,
  type NarrationFixtureEntry,
  type NarrationFixtureFile,
} from "../server/services/narrator.js";

const baseURL = process.env.NARRATOR_BASE_URL ?? "http://127.0.0.1:8000/v1";
const apiKey = process.env.NARRATOR_API_KEY ?? "local-vllm";
const model = process.env.NARRATOR_MODEL ?? "openai/gpt-oss-20b";
const outputPath = path.resolve(process.cwd(), "tests/fixtures/narration.json");
const maxAttempts = Number(process.env.FIXTURE_RECORD_MAX_ATTEMPTS ?? 10);

async function recordScenario(scenarioId: string): Promise<NarrationFixtureEntry[]> {
  const scenario = demoScenarios.find((candidate) => candidate.id === scenarioId);
  if (!scenario) throw new Error("Unknown scenario: " + scenarioId);

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const narrator = new NarratorService({
      apiKey,
      baseURL,
      model,
      logger: consoleServiceLogger,
      fixtureStore: NarrationFixtureStore.empty(),
    });
    const agent = new AgentService("", silentServiceLogger);
    const orchestrator = new Orchestrator(agent, narrator);
    const session = new CallSession("fixture_" + scenario.id + "_" + attempt, true);
    const emit = (_event: ServerEvent) => undefined;

    await orchestrator.startCall(session, scenario.id, "live", emit);
    for (const scriptedTurn of scenario.turns) {
      await orchestrator.handleCallerText(session, scriptedTurn.caller, emit);
      if (scriptedTurn.expectState && workflowState(session.workflow) !== scriptedTurn.expectState) {
        throw new Error(
          scenario.id +
            " entered " +
            workflowState(session.workflow) +
            " instead of " +
            scriptedTurn.expectState,
        );
      }
      if (session.outcome) break;
    }

    const agentTurns = session.transcript.filter((turn) => turn.role === "agent");
    const invalid = agentTurns.filter(
      (turn) => turn.narration?.renderedBy !== "model" || turn.narration.fidelity.status !== "verified",
    );
    const outcomeMatches = session.outcome === scenario.expectedOutcome;
    const reasonsMatch = scenario.expectedReasons.every((reason) => session.escalationReasons.includes(reason));
    if (!invalid.length && outcomeMatches && reasonsMatch) {
      return agentTurns.map((turn) => {
        const trace = turn.narration;
        if (!trace?.fidelity.candidateText) throw new Error("Verified model turn is missing its candidate draft");
        const occurrence = Number(trace.fixtureKey?.split(":").at(-1) ?? 0);
        return {
          key: [scenario.id, trace.intent, occurrence].join(":"),
          scenarioId: scenario.id,
          intent: trace.intent,
          occurrence,
          candidateText: trace.fidelity.candidateText,
        };
      });
    }

    const details = invalid
      .map((turn) => {
        const trace = turn.narration;
        return [
          trace?.intent ?? "unknown",
          trace?.fallbackReason ?? "unknown fallback",
          ...(trace?.fidelity.violations.map((violation) => violation.detail) ?? []),
        ].join(" | ");
      })
      .join("\n");
    console.warn("Retrying " + scenario.id + " after attempt " + attempt + "\n" + details);
  }

  throw new Error("Could not record a fully verified fixture set for " + scenarioId);
}

const entries: NarrationFixtureEntry[] = [];
for (const scenario of demoScenarios) {
  console.info("Recording " + scenario.id + " with " + model);
  entries.push(...(await recordScenario(scenario.id)));
}

const duplicateKeys = entries
  .map((entry) => entry.key)
  .filter((key, index, keys) => keys.indexOf(key) !== index);
if (duplicateKeys.length) throw new Error("Duplicate narration fixture keys: " + duplicateKeys.join(", "));

const fixture: NarrationFixtureFile = {
  schemaVersion: 1,
  recordedAt: new Date().toISOString(),
  provider: "local-vllm",
  model,
  entries,
};

mkdirSync(path.dirname(outputPath), { recursive: true });
writeFileSync(outputPath, JSON.stringify(fixture, null, 2) + "\n", "utf8");
console.info("Recorded " + entries.length + " verified lines to " + outputPath);
