# Meridian & Pine voice agent demo

A portfolio-quality, browser-based voice AI vertical slice for a fictional travel agency. The inbound agent can identify a synthetic hotel reservation, collect new dates, present exactly three mock options, require explicit confirmation, and speak a fictional change confirmation.

It cannot connect to a travel provider, charge a card, contact a human, or create a real booking. Those boundaries are enforced in the server workflow and disclosed in the interface and spoken greeting.

## What is included

- Browser microphone capture, 24 kHz PCM streaming, live speech-to-text, agent interpretation, and text-to-speech
- Guarded XState conversation workflow with deterministic policy checks before model interpretation
- One synthetic `manage_reservation` tool with `find`, `quote_date_change`, and `confirm_date_change` actions
- Live transcript with partial and final turns
- Visible tool arguments, results, statuses, latency, call history, and final outcome
- Deterministic escalation for payment disputes, cancellation penalties, urgent disruption, repeated uncertainty, and tool failure
- Five one-click scripted evaluation calls that also run as automated regressions
- Editable identity/date repair and typed-turn fallback when browser audio is unavailable
- Downloadable JSON trace with an explicit synthetic-data disclaimer

## Architecture

Live voice path:

`microphone -> AudioWorklet -> app WebSocket -> OpenAI Realtime transcription -> guarded agent -> mock reservation tool -> OpenAI TTS -> browser audio`

Scenario Playback uses the same workflow, policy, tool, telemetry, and UI but swaps hosted inference for a deterministic parser and browser speech synthesis. This makes the full demo reviewable without an API key while keeping the mode visibly labeled.

The LLM does narrow interpretation only: intent and slot extraction. XState owns conversation progression, deterministic policy owns escalation, and the server is the only component allowed to invoke the mock tool. No model response directly mutates a reservation.

## Stack

- React 19, TypeScript, Vite
- Fastify HTTP/WebSocket server
- XState guarded conversation machine
- Zod boundary and tool validation
- OpenAI Realtime transcription (`gpt-live-transcribe` by default)
- OpenAI Responses API structured output (`gpt-5.4-mini` by default)
- OpenAI text-to-speech (`gpt-4o-mini-tts`, `coral` by default)
- Vitest and Playwright

## Run it

Requirements: Node.js 22+ and npm.

```bash
npm install
npm run dev
```

Open `http://localhost:5173`. Scenario Playback is immediately available and uses no external service.

For live microphone mode, provide an OpenAI API key to the server process:

```bash
OPENAI_API_KEY=your_key npm run dev
```

Optional configuration is documented in [.env.example](./.env.example). The API key is never sent to the browser; the server owns both hosted-model connections.

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

## Scripted evaluations

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

`npm test` verifies policy, parsing, exact identity matching, three-option quoting, invalid dates, idempotency, all five complete conversations, explicit confirmation before mutation, handoff reasons, spoken disclosure, and final outcome. `npm run eval` prints a compact five-call scorecard. The Playwright smoke test launches the production app and verifies the visible transcript, tool trace, final outcome, and structural assertions.

## Project map

- [`src/App.tsx`](./src/App.tsx) — browser conversation and operations UI
- [`server/index.ts`](./server/index.ts) — API, WebSocket boundary, quotas, live transcription wiring
- [`server/orchestrator.ts`](./server/orchestrator.ts) — guarded agent orchestration and telemetry
- [`server/domain/workflow.ts`](./server/domain/workflow.ts) — conversation state machine
- [`server/domain/reservationTool.ts`](./server/domain/reservationTool.ts) — the only mock reservation tool
- [`src/shared/scenarios.ts`](./src/shared/scenarios.ts) — synthetic seeds and five evaluation calls
- [`tests/orchestrator.test.ts`](./tests/orchestrator.test.ts) — full scripted-call regression suite

## Deployment note

The included Dockerfile serves the built frontend and API from one process. Use HTTPS in deployment because browsers require a secure context for microphone access. Keep `OPENAI_API_KEY` server-side, set conservative platform spending limits, and replace in-memory quotas/session state with shared storage before scaling beyond a single demo instance.
