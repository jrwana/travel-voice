import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import fastifyStatic from "@fastify/static";
import fastifyWebsocket from "@fastify/websocket";
import Fastify from "fastify";
import WebSocket from "ws";
import type { BootstrapResponse, ServerEvent } from "../src/shared/contracts.js";
import { clientMessageSchema } from "../src/shared/contracts.js";
import { demoScenarios } from "../src/shared/scenarios.js";
import { Orchestrator, type EmitEvent } from "./orchestrator.js";
import { QuotaManager } from "./quota.js";
import { SessionStore } from "./session.js";
import { AgentService } from "./services/agent.js";
import type { ServiceLogger } from "./services/logger.js";
import { NarratorService } from "./services/narrator.js";
import { RealtimeTranscriber } from "./services/realtimeTranscriber.js";

const app = Fastify({ logger: true, trustProxy: true, bodyLimit: 1_000_000 });
const serviceLogger: ServiceLogger = {
  error: (context, message) => app.log.error(context, message),
  warn: (context, message) => app.log.warn(context, message),
  info: (context, message) => app.log.info(context, message),
};
const agent = new AgentService(process.env.OPENAI_API_KEY, serviceLogger);
const narrator = new NarratorService({ logger: serviceLogger });
const sessions = new SessionStore(agent.available);
const orchestrator = new Orchestrator(agent, narrator);
const quota = new QuotaManager();
const port = Number(process.env.PORT ?? 3001);
const rootDir = process.cwd();

await app.register(fastifyWebsocket, { options: { maxPayload: 300_000 } });

app.addHook("onSend", async (_request, reply, payload) => {
  reply.header("X-Content-Type-Options", "nosniff");
  reply.header("Referrer-Policy", "no-referrer");
  reply.header("Permissions-Policy", "microphone=(self)");
  reply.header("Cross-Origin-Resource-Policy", "same-origin");
  return payload;
});

app.get("/api/health", async () => ({
  ok: true,
  aiAvailable: agent.available,
  mode: agent.available ? "live-ready" : "playback-ready",
}));

app.post("/api/bootstrap", async (): Promise<BootstrapResponse> => {
  const session = sessions.create();
  return {
    sessionId: session.sessionId,
    scenarios: demoScenarios,
    snapshot: session.snapshot(),
    limits: {
      maxCallSeconds: quota.limits.maxCallSeconds,
      maxConcurrentCalls: quota.limits.maxConcurrentCalls,
      maxDailyCalls: quota.limits.maxDailyCalls,
    },
  };
});

app.get<{ Params: { id: string } }>("/api/sessions/:id/export", async (request, reply) => {
  const session = sessions.get(request.params.id);
  if (!session) return reply.code(404).send({ error: "Session expired" });
  reply.header("Content-Disposition", `attachment; filename=meridian-pine-${session.sessionId}.json`);
  return {
    exportedAt: new Date().toISOString(),
    disclaimer: "Synthetic portfolio-demo data. No real booking or payment.",
    snapshot: session.snapshot(),
  };
});

app.get<{ Querystring: { sessionId?: string } }>(
  "/ws",
  { websocket: true },
  (socket, request) => {
    const session = request.query.sessionId ? sessions.get(request.query.sessionId) : undefined;
    if (!session) {
      socket.send(JSON.stringify({ type: "notice", level: "error", message: "Session expired. Reload the demo." }));
      socket.close(1008);
      return;
    }

    let transcriber: RealtimeTranscriber | undefined;
    let liveQuotaConsumed = false;
    let processing = Promise.resolve();
    let callTimer: NodeJS.Timeout | undefined;
    let suiteRunId = 0;
    const emit: EmitEvent = (event: ServerEvent) => {
      if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(event));
    };
    const releaseLive = () => {
      if (liveQuotaConsumed) quota.release();
      liveQuotaConsumed = false;
      transcriber?.close();
      transcriber = undefined;
      if (callTimer) clearTimeout(callTimer);
      callTimer = undefined;
    };
    const finishIfNeeded = () => {
      if (session.outcome) releaseLive();
    };
    const enqueue = (work: () => Promise<void>) => {
      processing = processing.then(work).then(finishIfNeeded).catch((error: unknown) => {
        app.log.error(error);
        emit({ type: "notice", level: "error", message: "The demo hit an unexpected error. No change was made." });
      });
    };

    emit({ type: "session.ready", snapshot: session.snapshot() });

    socket.on("message", (raw) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw.toString());
      } catch {
        emit({ type: "notice", level: "error", message: "Invalid client event." });
        return;
      }
      const result = clientMessageSchema.safeParse(parsed);
      if (!result.success) {
        emit({ type: "notice", level: "error", message: "Rejected an invalid client event." });
        return;
      }
      const message = result.data;
      if (message.type === "audio.chunk") {
        transcriber?.append(message.audio);
        return;
      }
      if (message.type === "call.start") {
        suiteRunId += 1;
        enqueue(async () => {
          releaseLive();
          if (message.mode === "live") {
            if (!agent.available) {
              emit({ type: "notice", level: "warning", message: "Live AI is not configured. Use Scenario Playback." });
              return;
            }
            const decision = quota.checkAndConsume(session.sessionId, request.ip);
            if (!decision.allowed) {
              emit({ type: "notice", level: "warning", message: decision.reason ?? "Live quota unavailable." });
              return;
            }
            liveQuotaConsumed = true;
          }
          await orchestrator.startCall(session, message.scenarioId, message.mode, emit);
          if (message.mode === "live" && process.env.OPENAI_API_KEY) {
            const safetyIdentifier = createHash("sha256")
              .update(`${request.ip}:${session.sessionId}`)
              .digest("hex")
              .slice(0, 64);
            transcriber = new RealtimeTranscriber(process.env.OPENAI_API_KEY, safetyIdentifier, {
              onSpeechStarted: () => {
                session.beginTurn();
                session.voiceMode = "listening";
                emit({ type: "snapshot", snapshot: session.snapshot() });
              },
              onPartial: (text) => {
                session.notePartial(text);
                emit({ type: "transcript.partial", text });
                emit({ type: "snapshot", snapshot: session.snapshot() });
              },
              onFinal: (text) => {
                const turn = session.completeTranscript(text);
                emit({ type: "transcript.final", turn });
                enqueue(() => orchestrator.handleCallerText(session, text, emit, false));
              },
              onError: (message) =>
                emit({ type: "notice", level: "error", message: `Live transcription: ${message}` }),
            });
            try {
              await transcriber.connect();
            } catch {
              emit({
                type: "notice",
                level: "error",
                message: "Microphone transcription could not connect. Typed turns remain available.",
              });
            }
          }
          callTimer = setTimeout(() => {
            enqueue(async () => {
              await orchestrator.endCall(session, emit);
              emit({ type: "notice", level: "warning", message: "The five-minute demo call limit was reached." });
            });
          }, quota.limits.maxCallSeconds * 1_000);
        });
        return;
      }
      if (message.type === "text.turn") {
        enqueue(() => orchestrator.handleCallerText(session, message.text, emit));
        return;
      }
      if (message.type === "identity.correct") {
        enqueue(() => orchestrator.correctIdentity(session, message.confirmationCode, message.lastName, emit));
        return;
      }
      if (message.type === "dates.correct") {
        enqueue(() => orchestrator.correctDates(session, message.checkIn, message.checkOut, emit));
        return;
      }
      if (message.type === "call.end") {
        suiteRunId += 1;
        enqueue(() => orchestrator.endCall(session, emit));
        return;
      }
      if (message.type === "session.reset") {
        suiteRunId += 1;
        releaseLive();
        enqueue(async () => {
          session.resetAll(message.scenarioId);
          emit({ type: "snapshot", snapshot: session.snapshot() });
        });
        return;
      }
      if (message.type === "scenario.play") {
        suiteRunId += 1;
        releaseLive();
        enqueue(async () => {
          await orchestrator.playScenario(session, message.scenarioId, emit);
        });
        return;
      }
      if (message.type === "scenario.suite.play") {
        releaseLive();
        const runId = ++suiteRunId;
        enqueue(async () => {
          await orchestrator.playScenarioSuite(session, emit, () => suiteRunId === runId);
        });
      }
    });

    socket.on("close", () => {
      suiteRunId += 1;
      releaseLive();
      if (session.callId && !session.outcome) void orchestrator.endCall(session, () => undefined);
    });
  },
);

const distDir = path.join(rootDir, "dist");
if (existsSync(distDir)) {
  await app.register(fastifyStatic, { root: distDir });
  app.setNotFoundHandler((request, reply) => {
    if (request.url.startsWith("/api/") || request.url.startsWith("/ws")) {
      return reply.code(404).send({ error: "Not found" });
    }
    return reply.sendFile("index.html");
  });
}

await app.listen({ port, host: "0.0.0.0" });
