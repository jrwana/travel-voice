# Testing and runbook

## Prerequisites

- Node.js 22 or newer
- npm
- Chromium installed by Playwright for browser smoke tests
- No API key is required for the verified replay suite
- `OPENAI_API_KEY` only for live STT, interpretation, and hosted TTS
- Optional OpenAI-compatible vLLM endpoint for narration and fixture recording

## Fast local check

```bash
npm install
npm run check
npm run eval
npm run test:e2e
```

The documented baseline is:

- TypeScript server and client builds pass
- 36 Vitest tests pass
- Five of five scripted calls pass
- One Playwright smoke test passes

Treat the exact counts as a historical baseline; new focused tests should increase them.

## Run the browser demo

```bash
npm run dev
```

With `OPENAI_API_KEY` configured, open `http://localhost:5173` and use **Start live call** first. The three suggested prompts should fill the composer without sending; reviewers may speak or type any paraphrase. Expected live evidence:

- The primary action is enabled and starts `live_exploration`
- Caller language is not restricted to the prompt suggestions
- Interpretation shows `Model` with latency
- Agent lines show `Live model · verified`
- Tool calls show arguments, public results, status, and duration
- The final card shows `changed` or `escalated`
- Exported JSON contains per-turn narration provenance and fidelity data

Without a key, the primary action remains visible but disabled with setup guidance. Use **Run verified scenarios** as the secondary evaluation and fallback path. Expected replay evidence:

- **Run all five** produces five scorecards; every scenario can also run individually
- Agent lines show `Replayed model fixture · verified`
- Interpretation shows `Deterministic parser`
- Batch replay is muted; individual replay can use browser speech
- Scorecards report expected and actual outcome, assertions, tool count, and language-source counts

## Five-call acceptance matrix

| Scenario | Expected state/outcome | Mutation expectation |
| --- | --- | --- |
| `happy_exact` | Ends `changed` after first option and explicit yes | Find, quote, and exactly one confirm |
| `happy_correction` | Repairs invalid dates, then ends `changed` | Two quotes and exactly one confirm |
| `payment_penalty` | Escalates for payment dispute and cancellation penalty | No reservation tool call |
| `urgent_disruption` | Escalates for urgent disruption | No reservation tool call |
| `identity_uncertainty` | One failed lookup, then uncertainty escalation | Find only; no confirm |

For every escalation, verify that the UI states no external queue or human was contacted.

## Record narration fixtures

The default recorder expects:

```text
base URL: http://127.0.0.1:8000/v1
model:    openai/gpt-oss-20b
```

Run:

```bash
curl http://127.0.0.1:8000/v1/models
npm run fixtures:record
git diff -- tests/fixtures/narration.json
npm test
```

The recorder runs all five scenarios in live-renderer mode. It retries bounded failures and refuses to write unless every agent line is model-rendered and verified and every scenario reaches its expected outcome and escalation reasons.

Review generated prose manually even after verification. The verifier proves protected-fact fidelity and required safety frames; human review still catches tone and grammar issues.

## Use remote vLLM from a Mac

On the Mac:

```bash
ssh -N -L 8000:127.0.0.1:8000 joe@REMOTE_PC
```

Then, in another Mac terminal:

```bash
curl http://127.0.0.1:8000/v1/models

NARRATOR_BASE_URL=http://127.0.0.1:8000/v1 \
NARRATOR_API_KEY=local-vllm \
NARRATOR_MODEL=openai/gpt-oss-20b \
npm run fixtures:record
```

Do not expose port 8000 publicly. If local port 8000 is occupied, forward local 18000 to remote 8000 and update `NARRATOR_BASE_URL`.

## Test live browser voice

```bash
OPENAI_API_KEY=your_key \
NARRATOR_BASE_URL=http://127.0.0.1:8000/v1 \
NARRATOR_API_KEY=local-vllm \
NARRATOR_MODEL=openai/gpt-oss-20b \
npm run dev
```

Open `http://localhost:5173`, choose **Start live call**, allow microphone access, and speak only synthetic details. Expected differences from replay:

- Interpretation shows `Model` with latency
- Agent lines show `Live model · verified`
- Hosted TTS returns audio when available
- Any interpretation, narration, or TTS failure produces a visible warning and traceable fallback

## Fact-fidelity negative tests

The test suite should continue proving that a candidate falls back when it contains:

- A fabricated literal date
- A fabricated literal price
- A fabricated confirmation number
- A raw room type instead of its placeholder
- Unknown or missing placeholders
- Extra numeric option markers outside approved labels
- Claims that a real human is handling or routing an escalation

When extending a fact type, add all of the following together:

`typed facts -> binding -> model prompt description -> verifier rule -> template -> focused rejection test -> trace/UI review`

## Trace audit

Use Export trace after a call. For each agent transcript turn, inspect:

```text
narration.intent
narration.renderedBy
narration.model
narration.fixtureKey
narration.fidelity.status
narration.fidelity.violations
narration.fallbackReason
```

For successful replay, all agent turns should be `fixture` and `verified`. For successful live narration, they should be `model` and `verified`. A `template` line must include a reason or indicate that the preferred source was unavailable.

## Pre-commit discipline

Before each coherent commit:

```bash
git diff --check
npm test
npm run build
git status --short
```

Before reporting a major slice complete:

```bash
npm run check
npm run eval
npm run test:e2e
```

Stage only files belonging to that step. Preserve unrelated working-tree changes and report them explicitly.
