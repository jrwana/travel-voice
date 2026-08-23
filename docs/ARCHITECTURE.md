# Architecture

## Design thesis

The demo separates conversational fluency from operational authority.

`model proposes language -> deterministic code verifies -> caller hears hydrated facts`

This makes the model useful without allowing it to choose an option, authorize a mutation, invent availability, decide an escalation, or contact an external system.

## Component map

| Component | Responsibility | Authority |
| --- | --- | --- |
| React browser UI | Microphone capture, audio playback, transcript, provenance, tool/latency/outcome display | Sends validated client events only |
| Fastify/WebSocket boundary | Sessions, quotas, event serialization, live STT connection, static serving | Owns server boundary and secrets |
| Deterministic policy | Detect mandatory escalation and unsupported requests before interpretation | Can stop automated processing |
| `AgentService` | Extract intent and caller-stated slots; synthesize speech in live mode | Cannot progress workflow or call tools |
| XState workflow | Define legal conversation states and transitions | Owns progression vocabulary |
| Orchestrator | Order policy, interpretation, state transitions, tools, narration, and telemetry | Coordinates deterministic decisions |
| `MockReservationTool` | Find, quote, and confirm synthetic reservations | Only reservation mutation path |
| `NarratorService` | Phrase one closed speech intent over deterministic facts | Language only |
| Fact-fidelity verifier | Reject unsupported facts, missing facts, malformed language, and unsafe claims | Can force template fallback |
| Fixture store | Replay recorded model drafts deterministically | No decisions; drafts are re-verified |

## Live caller-turn flow

Every finalized caller turn follows this order:

`caller audio -> STT -> transcript -> evaluatePolicy()`

Policy creates one of three branches:

1. Mandatory escalation:

   `policy match -> XState ESCALATE -> handoff summary -> escalate narration -> verifier -> TTS -> end`

2. Unsupported request:

   `scope repair or UNSUPPORTED -> narration -> verifier -> TTS -> end when required`

3. In-scope request:

   `AgentService interpretation -> deterministic state handler -> optional mock tool -> decided facts -> narration -> verifier -> TTS`

The escalation narrator runs only after the system is already escalated. It explains an existing decision; it does not make that decision.

## Scenario Playback flow

Playback is designed for reviewers who have no API key:

`scripted caller turn -> deterministic parser -> same policy/workflow/tool path`

Caller-facing language then follows:

`scenario + speech intent + occurrence -> recorded model draft -> verifier -> fact hydration -> browser TTS`

The committed fixture stores placeholder-bound drafts, not pre-hydrated output. Runtime verification therefore remains active and a stale or unsafe fixture falls back visibly instead of being trusted because it is committed.

## Conversation progression

Happy path:

`idle -> greeting -> identifying -> collecting_dates -> quoting -> presenting_options -> awaiting_selection -> awaiting_confirmation -> applying_change -> confirmed -> ended`

Important recovery transitions:

- Invalid dates: `quoting -> collecting_dates`
- Revised dates: `awaiting_selection or awaiting_confirmation -> collecting_dates`
- Revised selection: `awaiting_confirmation -> awaiting_selection`
- Stale quote: `applying_change -> quoting`
- Any mandatory stop: `active state -> escalated or unsupported -> ended`

XState constrains legal states, while the orchestrator still owns data dependencies and side-effect ordering.

## Model authority boundary

### Turn interpretation

The live interpretation model returns a strict JSON schema containing intent, identity fields, dates, option number, affirmation, and denial. The result is input to deterministic handlers. It cannot emit a workflow event or tool call directly.

### Language rendering

The narrator receives one of 17 closed speech intents, such as `greeting`, `reservation_found`, `present_options`, `ask_confirmation`, `confirm_changed`, or `escalate`.

Facts are converted into named bindings such as:

```text
{{selected_check_in}}
{{selected_check_out}}
{{selected_room_type}}
{{selected_price}}
```

The model sees the placeholder and its semantic description, not the underlying protected value. It produces a placeholder-bound draft. This choice reduces the hallucination surface before verification begins.

## Fact-fidelity verification

Verification has two phases.

### Draft verification

Before hydration, deterministic code checks:

- Every required placeholder is present
- Every placeholder is known for that intent
- No literal date, price, confirmation code, room type, option label, option count, or numeric list marker bypasses a placeholder
- Required safety and communication phrases are present
- Output is plain caller-facing text with acceptable length and punctuation
- Escalation language does not claim a person is ready, handling, routed, contacted, transferred, queued, or scheduled to act

### Hydrated verification

After placeholders are replaced, the verifier extracts protected fact shapes again. Every detected value must trace to one of the supplied binding values.

Failure follows:

`candidate rejected -> violation recorded -> server warning -> original template -> visible Template fallback badge`

Templates are deterministic, remain intent-specific, and are checked against supplied fact bindings before use.

## Reservation mutation boundary

The single `manage_reservation` tool supports:

```text
find -> quote_date_change -> confirm_date_change
```

Key properties:

- It exists only on the server.
- Every browser session receives isolated in-memory synthetic data.
- Quote results contain exactly three mock options.
- Quote tokens expire.
- Confirmation uses quote token, option ID, and idempotency key.
- The orchestrator reaches confirmation only through the explicit-confirmation workflow state.
- Tool arguments, status, duration, and public result are captured in the trace.

## Observability

Each agent transcript turn carries a narration trace with:

- Speech intent
- `renderedBy`: `model`, `fixture`, or `template`
- Renderer latency and model identifier
- Fixture key when applicable
- Fidelity status, candidate draft, violations, and fallback reason

Snapshots transmit this trace to the browser, and session export preserves it in JSON. Interpretation and narration provenance are separate so playback displays `Deterministic parser` and `Verified model fixture` instead of a misleading `LLM 0ms`.

## Failure behavior

| Failure | Behavior |
| --- | --- |
| Live interpretation model fails | Log error, deterministic parser fallback, visible warning |
| Narration model fails | Log error, verified template fallback, provenance badge and warning |
| Narration violates fidelity | Record candidate and violations, verified template fallback |
| Hosted TTS fails | Log error, browser speech fallback, visible warning |
| Fixture is missing or invalid | Template fallback; never silently use stale language |
| Tool returns unsafe failure | Escalate with `tool_failure` and/or `uncertainty`; do not claim mutation |
| Session or quota limit reached | End or reject live call without external side effects |

## Trust boundaries

- Browser input is untrusted and validated with Zod.
- Caller speech is untrusted and passes deterministic policy before model interpretation.
- Model output is untrusted and schema-validated or fact-verified.
- Fixture content is untrusted at runtime despite being committed.
- Only server code has provider credentials and tool access.
- Exported data is synthetic but still session-scoped and expires with in-memory session cleanup.
