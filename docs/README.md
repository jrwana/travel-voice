# Project documentation

This folder preserves the reasoning that is easy to lose when only the implementation and commit history remain. It is intended for maintainers and reviewers evaluating the safety architecture.

## Reading order

1. [ARCHITECTURE.md](./ARCHITECTURE.md) - control flow, trust boundaries, model authority, narration verification, and failure behavior
2. [DECISIONS.md](./DECISIONS.md) - why the major product and technology choices were made
3. [TESTING.md](./TESTING.md) - automated commands, manual acceptance checks, local-vLLM recording, and trace inspection

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

The language layer and live-first demo strategy are split into reviewable commits:

- `74a903d` - fact-verified narration service
- `94432e2` - all speech sites routed through narration intents
- `38900ac` - verified local-model playback fixtures
- `750177a` - visible narration provenance and source-aware metrics
- `3929632` - hardened live confirmation interpretation
- `1df7900` - context-aware numeric option selection
- `30c3e8e` - verified scenario suite runner and scorecards
- `58a011a` - guarded live paraphrase regression
- `441b62b` - live-first interface and secondary replay suite

At that baseline, `npm run check`, `npm run eval`, and `npm run test:e2e` all pass.
