# Project documentation

This folder preserves the reasoning that is easy to lose when only the implementation and commit history remain. It is intended for maintainers and reviewers evaluating the safety architecture.

## Reading order

2. [ARCHITECTURE.md](./ARCHITECTURE.md) - control flow, trust boundaries, model authority, narration verification, and failure behavior
3. [DECISIONS.md](./DECISIONS.md) - why the major product and technology choices were made
4. [TESTING.md](./TESTING.md) - automated commands, manual acceptance checks, local-vLLM recording, and trace inspection

## Source-of-truth order

When documentation and implementation disagree, use this order:

1. Executable tests and schemas
2. Server control flow
3. This documentation
4. Product copy in the UI

The most important implementation files are:

- [`server/orchestrator.ts`](../server/orchestrator.ts) - turn ordering and authority boundaries
- [`server/services/narrator.ts`](../server/services/narrator.ts) - language rendering, verification, templates, and fixture replay
- [`server/domain/workflow.ts`](../server/domain/workflow.ts) - conversation states
- [`server/domain/policy.ts`](../server/domain/policy.ts) - deterministic escalation policy
- [`server/domain/reservationTool.ts`](../server/domain/reservationTool.ts) - the only reservation mutation path
- [`src/shared/scenarios.ts`](../src/shared/scenarios.ts) - synthetic data and the five evaluation calls

## Current baseline

The language-layer work is split into reviewable commits:

- `388311c` - fact-verified narration service
- `8451de5` - all speech sites routed through narration intents
- `faa01a2` - verified local-model playback fixtures
- `5aa1791` - visible narration provenance and source-aware metrics

At that baseline, `npm run check`, `npm run eval`, and `npm run test:e2e` all pass.
