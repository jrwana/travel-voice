import { describe, expect, it } from "vitest";
import { parseTurnDeterministic } from "../server/domain/parser.js";
import { reconcileLiveTurn, type ModelTurn } from "../server/services/agent.js";

const modelTurn = (overrides: Partial<ModelTurn> = {}): ModelTurn => ({
  intent: "other",
  confirmationCode: null,
  lastName: null,
  checkIn: null,
  checkOut: null,
  optionNumber: null,
  affirmed: false,
  denied: false,
  ...overrides,
});

describe("live interpretation reconciliation", () => {
  it("does not preserve a deterministic affirmation when the live model disagrees", () => {
    const deterministic = parseTurnDeterministic("Yes, confirm it.");
    expect(deterministic.affirmed).toBe(true);

    expect(reconcileLiveTurn(modelTurn(), deterministic)).toMatchObject({
      affirmed: false,
      denied: false,
    });
  });

  it("turns conflicting live confirmation signals into an ambiguous turn", () => {
    const deterministic = parseTurnDeterministic("Go ahead, but no, stop.");
    expect(reconcileLiveTurn(modelTurn({ affirmed: true, denied: true }), deterministic)).toMatchObject({
      affirmed: false,
      denied: false,
    });
  });

  it("uses an unambiguous live confirmation without deterministic boolean merging", () => {
    const deterministic = parseTurnDeterministic("No, don't do it.");
    expect(reconcileLiveTurn(modelTurn({ intent: "confirm", affirmed: true }), deterministic)).toMatchObject({
      affirmed: true,
      denied: false,
    });
  });
});
