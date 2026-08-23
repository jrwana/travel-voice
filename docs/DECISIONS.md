# Architecture and product decisions

These records explain why the project is built this way and what each choice costs.

## D1. Use deterministic policy before any caller-turn model call

**Choice:** Run `evaluatePolicy()` before live intent extraction.

**Why:** Payment disputes, penalties, and urgent disruption are business-policy decisions, not language-generation problems. Early policy evaluation prevents a model classification from routing around a mandatory handoff and avoids spending model latency on turns that must stop.

**Tradeoff:** Keyword policy has lower recall than a broad semantic classifier. The appropriate response is a tested policy corpus, not moving authority back into the model.

## D2. Use XState for progression

**Choice:** Represent the conversation as explicit states and events.

**Why:** A voice agent can receive corrections, denials, stale quotes, and ambiguous turns. XState makes legal progression inspectable and testable, and it prevents a language model from implicitly becoming the workflow engine.

**Tradeoff:** The orchestrator and state machine must evolve together. This is extra ceremony for a small demo, but that ceremony is the portfolio evidence that side effects are controlled.

## D3. Give the model language, not authority

**Choice:** The narrator renders one closed intent over facts already computed by code.

**Why:** Fully templated speech made the demo look like a state machine with voice attached. Free-form agent generation would undermine safety. A renderer preserves natural language while keeping selection, confirmation, escalation, and tools deterministic.

**Tradeoff:** The language model has less freedom than a general agent. That is intentional for transactional support where a fabricated date or price is more damaging than repetitive phrasing.

## D4. Bind facts through placeholders

**Choice:** Ask the model to place `{{fact_name}}` tokens, verify the draft, and hydrate later.

**Why:** Post-hoc checks over raw model prose are difficult because dates and prices have many formats. Placeholder binding makes provenance constructive: a protected fact can enter speech only through an approved slot. The final hydrated pass adds defense in depth.

**Tradeoff:** Prompt constraints can produce awkward grammar if a slot is treated as a noun when it is actually a complete phrase. Intent-specific required frames for prices and escalation reasons solve this deterministically.

## D5. Keep the original templates

**Choice:** Every speech intent retains a built-in template.

**Why:** Voice support must fail safe and remain understandable when the renderer is unavailable or rejected. Templates also create a known-good comparison for tests and incident traces.

**Tradeoff:** Templates must be updated when facts or safety disclosures change. They should be treated as executable safety assets rather than incidental copy.

## D6. Record and replay model fixtures

**Choice:** Scenario Playback uses drafts recorded from a live model and re-verifies them on every run.

**Why:** A reviewer without an API key should still hear authentic model language. Record/replay provides that experience while keeping demos and CI deterministic, fast, and free of provider variance.

**Tradeoff:** Fixtures can become stale when prompts or fact contracts change. Runtime verification and a strict recorder turn staleness into a visible fallback rather than silent drift.

## D7. Use one server-only mock reservation tool

**Choice:** Put find, quote, and confirm behind one discriminated server contract.

**Why:** One tool makes the mutation boundary easy to audit. The browser cannot forge provider access, and the trace can show every argument, result, status, and duration without pretending multiple fake integrations exist.

**Tradeoff:** This is not a provider abstraction or production booking integration. That limitation is honest and keeps the first slice focused on orchestration quality.

## D8. Use synthetic, session-local data

**Choice:** Seed two fictional reservations and clone them into each browser session.

**Why:** The demo can show a complete change and idempotent mutation without privacy, compliance, sandbox-account, or accidental-booking risk. Reset restores a predictable baseline for demos and tests.

**Tradeoff:** In-memory state cannot demonstrate cross-session persistence or multi-instance behavior. Production architecture would require a durable transactional store.

## D9. Separate interpretation provenance from language provenance

**Choice:** Track `interpretationBy` and `narrationBy` independently.

**Why:** Playback uses a deterministic parser but authentic recorded model language. A single `LLM` latency tile hid this distinction and displayed `0ms`, which looked like the model was absent. Separate provenance tells the truth about both layers.

**Tradeoff:** The UI and trace contain more concepts. The extra precision is worth it because it resembles the operational observability real voice platforms need.

## D10. Use Fastify and WebSockets

**Choice:** Use one TypeScript server for HTTP bootstrap/export, WebSocket events, quotas, STT streaming, tools, and static production serving.

**Why:** Voice is event-oriented: partial transcripts, final turns, tool updates, speech, and snapshots arrive over time. WebSockets fit that sequence, while Fastify keeps the demo deployable as one process.

**Tradeoff:** There is no distributed event bus or durable job layer. That would be premature for a single-user portfolio slice.

## D11. Use React, TypeScript, Zod, Vitest, and Playwright

**Choice:** Keep one typed contract surface across browser, server, tests, and fixtures.

**Why:** TypeScript catches intent/fact mismatches at build time; Zod validates runtime client and fixture boundaries; Vitest exercises policy and orchestration quickly; Playwright proves the reviewer-visible flow rather than only server internals.

**Tradeoff:** Compile-time types do not validate model output or network input. That is why strict schemas and deterministic verification remain necessary.

## D12. Split hosted voice services from optional local narration

**Choice:** Live STT, turn interpretation, and TTS use OpenAI configuration, while the narrator has independent `NARRATOR_*` settings and supports an OpenAI-compatible vLLM endpoint.

**Why:** This allows local GPU experimentation and committed fixture generation without coupling every modality to one provider. On a Mac, an SSH tunnel can expose remote vLLM as local port 8000 while the browser and app run locally.

**Tradeoff:** Full live voice still needs hosted STT/TTS credentials. The local vLLM primarily benefits narration experiments and fixture recording unless more modalities are replaced later.

## D13. Make degradation visible

**Choice:** Log model failures, emit UI notices, attach fallback reasons to traces, and badge every line by source.

**Why:** Silent fallback makes a demo look healthy while hiding that the model never ran. Voice-agent operations need to distinguish latency, policy, model, tool, and synthesis failures quickly.

**Tradeoff:** The interface exposes implementation detail. That is a feature for this portfolio because the audience is evaluating platform thinking, not only consumer polish.
