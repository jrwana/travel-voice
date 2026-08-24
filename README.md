# Meridian & Pine voice agent demo

A portfolio-quality, browser-based voice AI vertical slice for a fictional travel agency. The inbound agent can identify a synthetic hotel reservation, collect new dates, present exactly three mock options, require explicit confirmation, and speak a fictional change confirmation.

It cannot connect to a travel provider, charge a card, contact a human, or create a real booking. Those boundaries are enforced in the server workflow and disclosed in the interface and spoken greeting.

## What is included

- Browser microphone capture, 24 kHz PCM streaming, live speech-to-text, agent interpretation, and text-to-speech
- Guarded XState conversation workflow with deterministic policy checks before model interpretation
- One synthetic `manage_reservation` tool with `find`, `quote_date_change`, and `confirm_date_change` actions
- Live transcript with partial and final turns
- Model-authored caller language with deterministic fact-fidelity verification and built-in template fallback
- Per-line language provenance (`model`, `fixture`, or `template`) in the UI and exported trace
- Visible tool arguments, results, statuses, source-aware latency, call history, and final outcome
- Deterministic escalation for payment disputes, cancellation penalties, urgent disruption, repeated uncertainty, and tool failure
- A five-call verified scenario suite with run-all and individual replay controls, reproducibility scorecards, and automated regressions
- Editable identity/date repair and typed-turn fallback when browser audio is unavailable
- Downloadable JSON trace with an explicit synthetic-data disclaimer

## Architecture

Live voice path:

`microphone -> AudioWorklet -> app WebSocket -> STT -> deterministic policy/workflow -> mock tool -> model renderer -> fact verifier -> TTS -> browser audio`

Verified Scenario Replay is the evaluation and fallback path, not the primary experience. It uses the same workflow, policy, tool, verifier, telemetry, and UI, but replaces live interpretation with the deterministic parser and replays committed drafts recorded from a model. Every draft is re-verified and hydrated at runtime before browser speech synthesis. The UI labels this language as replayed so it cannot be mistaken for live AI.

The model has two narrow roles: live-mode intent/slot interpretation and caller-facing language rendering. XState owns progression, deterministic policy owns escalation, and the server is the only component allowed to invoke the mock tool. The renderer receives a speech intent plus already-computed facts only after code has made the decision. It cannot choose an option, confirm a mutation, escalate, or invoke a tool.

### Fact-fidelity verification

The narrator sends the model placeholder names and descriptions rather than raw dates, prices, room types, option labels, or confirmation numbers. For example, the model writes `{{selected_price}}`; deterministic code verifies the draft and only then hydrates that placeholder with the supplied value.

Before any line is spoken, the verifier rejects:

- Literal or unknown dates, prices, confirmation numbers, room types, option counts, and option labels
- Unknown placeholders, omitted required facts, or malformed output
- Missing safety language for fictional changes, payment boundaries, and simulated handoffs
- Claims that a real human is ready, handling, routed, contacted, or queued

After hydration, extracted factual values are checked again against the supplied bindings. A violation produces the original built-in template, records the rejected candidate and violations in the trace, logs the failure server-side, and displays `Template fallback` in the UI. This fallback is never silent.

## Stack

- React 19, TypeScript, Vite
- Fastify HTTP/WebSocket server
- XState guarded conversation machine
- Zod boundary and tool validation
- OpenAI Realtime transcription (`gpt-live-transcribe` by default)
- OpenAI Responses API structured output (`gpt-5.4-mini` by default)
- OpenAI-compatible Responses API narration renderer (`gpt-5.4-mini` by default)
- OpenAI text-to-speech (`gpt-4o-mini-tts`, `coral` by default)
- Vitest and Playwright

## Run it

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

For the primary live experience, provide an OpenAI API key to the server process:

```bash
OPENAI_API_KEY=your_key npm run dev
```

Open `http://localhost:5173` and choose **Start live call**. Speak or type natural caller language; the three suggested prompts are optional starting points and do not constrain the input.

Without an API key, the live action remains visible but disabled with setup guidance. The five verified scenarios remain available as a clearly labeled replay-based evaluation and fallback suite.

Optional configuration is documented in [.env.example](./.env.example). The API key is never sent to the browser; the server owns both hosted-model connections.

The live narrator uses the OpenAI-compatible Responses API with `instructions`, `input`, and `output_text`; see the [official Responses create reference](https://developers.openai.com/api/reference/typescript/resources/beta/subresources/responses/methods/create).

### Record replay fixtures with local vLLM

The recorder runs all five scenarios through the live renderer and refuses to write a fixture if any line falls back or fails verification. Its defaults target the local server used for this portfolio:

```bash
# Defaults: http://127.0.0.1:8000/v1 and openai/gpt-oss-20b
npm run fixtures:record
```

Override any OpenAI-compatible endpoint or model when needed:

```bash
NARRATOR_BASE_URL=http://127.0.0.1:8000/v1 \
NARRATOR_API_KEY=local-vllm \
NARRATOR_MODEL=openai/gpt-oss-20b \
npm run fixtures:record
```

The committed fixture contains placeholder-bound model drafts, provider/model metadata, and stable scenario/intent/occurrence keys. Replay re-verifies every draft; a missing or stale fixture is surfaced as a template fallback.

For a production-style local run:

```bash
npm run build
npm start
```

Then open `http://localhost:3001`.

## Synthetic reservations

| Confirmation | Last name | Stay |
| --- | --- | --- |
| `MPT-4821` | `Lee` | The Lume, Lisbon · Oct 12–16, 2027 |
| `MPT-7315` | `Patel` | Aoki House, Kyoto · Nov 3–7, 2027 |

Each browser session gets a fresh in-memory copy. A confirmed mock change is isolated to that session, and reset restores the seeds. Tool responses never expose the stored normalized last name or internal version field.

## Conversation contract

Happy path:

`idle -> greeting -> identifying -> collecting dates -> quoting -> presenting options -> selecting -> explicit confirmation -> applying mock change -> spoken confirmation -> ended`

Recovery paths handle missing identity fields, a failed lookup, invalid/revised dates, changing the selected option, denial at confirmation, and one stale-quote refresh. Repeated ambiguity escalates as uncertainty.

The single tool accepts this discriminated contract:

```ts
type ManageReservationInput =
  | { action: "find"; confirmationCode: string; lastName: string }
  | { action: "quote_date_change"; reservationId: string; checkIn: string; checkOut: string }
  | { action: "confirm_date_change"; quoteToken: string; optionId: string; idempotencyKey: string };
```

Quote tokens expire after ten minutes, confirmations are idempotent, and invalid or stale inputs fail closed.

## Safety and escalation

Policy is evaluated before the LLM on every caller turn. The automated path stops and creates a visible simulated handoff summary for:

- Payment, refund, billing, duplicate-charge, or chargeback disputes
- Cancellation requests, cancellation fees, or penalties
- Same-day or urgent disruption such as being stranded or a hotel closing tonight
- Two failed identity/date/selection/confirmation repairs
- Tool failure where a safe retry is unavailable

The summary includes reasons, the last caller turn, known synthetic identity, and a simulated queue label. No external person or system is contacted. Prompt-injection and unrelated requests receive one scope repair, then end safely.

Live-mode abuse controls are deliberately small-demo controls: five-minute calls, three concurrent calls, 50 live calls per process/day, five per browser session/hour, and ten per IP/day. These counters are in memory and should be moved to shared durable storage before multi-instance deployment.

## Verified scenario suite

| # | Scenario | Expected result |
| --- | --- | --- |
| 1 | Valid Lisbon date change, first option, explicit yes | Changed; three successful tool actions |
| 2 | Invalid Kyoto dates, correction, third option, explicit yes | Changed after safe date repair |
| 3 | Duplicate charge plus cancellation penalty | Escalated for both policy reasons; no tool mutation |
| 4 | Hotel closed tonight and caller stranded | Escalated as urgent disruption |
| 5 | Unknown confirmation and last name twice | Escalated for uncertainty |

Run the automated checks:

```bash
npm test
npm run eval
npm run test:e2e
```

In the browser, **Run all five** produces an aggregate scorecard, while each scenario also has an individual replay control. Batch replay is muted; an individual replay can be heard. Fixture-generated lines are explicitly labeled `Replayed model fixture · verified`.

`npm test` verifies policy, parsing, exact identity matching, three-option quoting, invalid dates, idempotency, all five complete conversations, explicit confirmation before mutation, handoff reasons, model-fixture provenance, fabricated-fact rejection, spoken disclosure, and final outcome. `npm run eval` prints a compact five-call scorecard. The Playwright smoke test launches the production app and verifies both run-all and individual replay controls, visible replay provenance, tool trace, scorecards, and outcomes.

## Project map

Deeper design rationale and testing procedures are indexed in [`docs/README.md`](./docs/README.md).

- [`src/App.tsx`](./src/App.tsx) — browser conversation and operations UI
- [`server/index.ts`](./server/index.ts) — API, WebSocket boundary, quotas, live transcription wiring
- [`server/orchestrator.ts`](./server/orchestrator.ts) — guarded agent orchestration and telemetry
- [`server/services/narrator.ts`](./server/services/narrator.ts) — model language renderer, verifier, templates, and fixture replay
- [`server/domain/workflow.ts`](./server/domain/workflow.ts) — conversation state machine
- [`server/domain/reservationTool.ts`](./server/domain/reservationTool.ts) — the only mock reservation tool
- [`src/shared/scenarios.ts`](./src/shared/scenarios.ts) — synthetic seeds and five evaluation calls
- [`tests/orchestrator.test.ts`](./tests/orchestrator.test.ts) — full scripted-call regression suite
- [`scripts/record-narration-fixtures.ts`](./scripts/record-narration-fixtures.ts) — strict five-scenario live-model recorder

## Deployment note

The included Dockerfile serves the built frontend and API from one process. Use HTTPS in deployment because browsers require a secure context for microphone access. Keep `OPENAI_API_KEY` server-side, set conservative platform spending limits, and replace in-memory quotas/session state with shared storage before scaling beyond a single demo instance.
