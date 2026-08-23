import { describe, expect, it } from "vitest";
import type { ChangeOption } from "../src/shared/contracts.js";
import {
  NarrationFixtureStore,
  NarratorService,
  narrationFixtureKey,
  verifyFactFidelity,
} from "../server/services/narrator.js";
import { silentServiceLogger } from "../server/services/logger.js";

const option: ChangeOption = {
  optionId: "opt_test",
  label: "Requested dates",
  checkIn: "2027-10-20",
  checkOut: "2027-10-24",
  roomType: "River king",
  priceDeltaCents: 12_000,
  currency: "USD",
  policySummary: "Synthetic flexible policy",
};

const liveContext = { live: true, scenarioId: "test", occurrence: 1 } as const;

describe("fact-fidelity verifier", () => {
  it("accepts a placeholder-bound line and hydrates only supplied facts", async () => {
    const narrator = new NarratorService({
      logger: silentServiceLogger,
      model: "test-model",
      generator: async () =>
        "I found a synthetic reservation for {{hotel_name}} in {{city}} from {{current_check_in}} to {{current_check_out}}. What are your new check-in and check-out dates?",
    });
    const result = await narrator.render(
      "reservation_found",
      {
        hotelName: "The Lume",
        city: "Lisbon",
        checkIn: "2027-10-12",
        checkOut: "2027-10-16",
      },
      liveContext,
    );

    expect(result.renderedBy).toBe("model");
    expect(result.text).toContain("The Lume");
    expect(result.text).toContain("October 12, 2027");
    expect(result.trace.fidelity.status).toBe("verified");
  });

  it.each([
    {
      label: "date",
      candidate:
        "At {{hotel_name}} in {{city}}, your stay is {{current_check_in}} to {{current_check_out}}. I also found December 9, 2029.",
      category: "raw_date",
    },
    {
      label: "price",
      candidate:
        "Your selection is {{selected_check_in}} to {{selected_check_out}}, {{selected_room_type}}, {{selected_price}}. A $999.00 fee applies. This is fictional; confirm?",
      category: "raw_price",
    },
  ])("rejects a fabricated $label and falls back to the verified template", async ({ candidate, category }) => {
    const narrator = new NarratorService({
      logger: silentServiceLogger,
      generator: async () => candidate,
    });
    const result =
      category === "raw_date"
        ? await narrator.render(
            "reservation_found",
            {
              hotelName: "The Lume",
              city: "Lisbon",
              checkIn: "2027-10-12",
              checkOut: "2027-10-16",
            },
            liveContext,
          )
        : await narrator.render("ask_confirmation", { option }, liveContext);

    expect(result.renderedBy).toBe("template");
    expect(result.trace.fallbackReason).toBe("fidelity_violation");
    expect(result.trace.fidelity.violations.map((violation) => violation.category)).toContain(category);
    expect(result.trace.fidelity.fallbackVerified).toBe(true);
    expect(result.text).not.toContain("999");
    expect(result.text).not.toContain("2029");
  });

  it("rejects a fabricated confirmation number and falls back", async () => {
    const narrator = new NarratorService({
      logger: silentServiceLogger,
      generator: async () =>
        "Your stay at {{hotel_name}} is now {{changed_check_in}} through {{changed_check_out}}. Your mock confirmation is {{mock_confirmation}}, plus MPC-FAKE9999. No real booking or payment was made.",
    });
    const result = await narrator.render(
      "confirm_changed",
      {
        hotelName: "The Lume",
        checkIn: "2027-10-20",
        checkOut: "2027-10-24",
        mockConfirmationNumber: "MPC-ABCD1234",
      },
      liveContext,
    );

    expect(result.renderedBy).toBe("template");
    expect(result.text).toContain("MPC-ABCD1234");
    expect(result.text).not.toContain("FAKE9999");
    expect(result.trace.fidelity.violations.map((violation) => violation.category)).toContain(
      "raw_confirmation",
    );
  });

  it("rejects raw room types, unknown placeholders, and omitted required facts", () => {
    const result = verifyFactFidelity(
      "ask_confirmation",
      { option },
      "Confirm {{selected_check_in}} to {{selected_check_out}} in a Deluxe suite for {{unknown_price}}. This is fictional.",
    );
    const categories = result.violations.map((violation) => violation.category);
    expect(categories).toContain("raw_room_type");
    expect(categories).toContain("unknown_placeholder");
    expect(categories).toContain("missing_required_fact");
  });

  it("rejects narration that claims a human is handling an escalation", () => {
    const result = verifyFactFidelity(
      "escalate",
      { reasons: ["uncertainty"], queueLabel: "priority support · simulated queue" },
      "This request involves {{escalation_reasons}} and needs a human travel specialist. A human travel specialist is handling it. A summary was prepared for a simulated handoff. No reservation or payment was changed.",
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(
      expect.objectContaining({
        category: "malformed_output",
        detail: expect.stringContaining("real handoff or queue action"),
      }),
    );
  });

  it("rejects raw numeric list markers even when approved option labels are present", () => {
    const options = [1, 2, 3].map((index) => ({ ...option, optionId: "opt_" + index }));
    const result = verifyFactFidelity(
      "present_options",
      { options },
      "Here are {{option_count}} mock options: 1) {{option_1_label}}, {{option_1_check_in}} to {{option_1_check_out}}, {{option_1_room_type}}, {{option_1_price}}. {{option_2_label}}, {{option_2_check_in}} to {{option_2_check_out}}, {{option_2_room_type}}, {{option_2_price}}. {{option_3_label}}, {{option_3_check_in}} to {{option_3_check_out}}, {{option_3_room_type}}, {{option_3_price}}. Which option would you like?",
    );

    expect(result.passed).toBe(false);
    expect(result.violations).toContainEqual(expect.objectContaining({ category: "raw_option_count" }));
  });
});

describe("fixture replay", () => {
  it("re-verifies and hydrates a committed model draft", async () => {
    const entry = {
      key: narrationFixtureKey("happy_exact", "greeting", 1),
      scenarioId: "happy_exact",
      intent: "greeting" as const,
      occurrence: 1,
      candidateText:
        "Hello, I'm the AI assistant for {{agency_name}}, a fictional AI demo using synthetic reservations. I only support hotel-date changes and cannot make a real booking or charge. Please share your confirmation code and last name.",
    };
    const narrator = new NarratorService({
      logger: silentServiceLogger,
      fixtureStore: new NarrationFixtureStore(
        { provider: "vllm", model: "openai/gpt-oss-20b", recordedAt: "2026-08-22T00:00:00.000Z" },
        [entry],
      ),
    });

    const result = await narrator.render(
      "greeting",
      { agencyName: "Meridian and Pine Travel" },
      { live: false, scenarioId: "happy_exact", occurrence: 1 },
    );
    expect(result.renderedBy).toBe("fixture");
    expect(result.text).toContain("Meridian and Pine Travel");
    expect(result.trace.model).toBe("openai/gpt-oss-20b");
  });

  it("loads 18 unique, local-model-authored committed fixture lines", () => {
    const store = NarrationFixtureStore.load();
    const entries = store.all();

    expect(store.metadata?.provider).toBe("local-vllm");
    expect(store.metadata?.model).toBe("openai/gpt-oss-20b");
    expect(entries).toHaveLength(18);
    expect(new Set(entries.map((entry) => entry.key)).size).toBe(entries.length);
  });
});
