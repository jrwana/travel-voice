import { expect, test } from "@playwright/test";

test("leads with live AI and keeps replayed scenarios as a verified suite", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Talk to a live voice agent/i })).toBeVisible();
  await expect(page.getByText("Fictional AI demo", { exact: true })).toBeVisible();
  const startLiveCall = page.getByRole("button", { name: "Start live call" });
  await expect(startLiveCall).toBeVisible();
  await expect(startLiveCall).toBeEnabled();
  await expect(page.getByText("Live models configured", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Call demo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent trace" })).toBeVisible();

  const prompt = "I was charged twice after cancelling, and I need to dispute it.";
  await page.getByRole("button", { name: prompt }).click();
  await expect(page.getByLabel("Typed caller language")).toHaveValue(prompt);
  await expect(page.getByText("Examples only. Speak or type any wording.", { exact: true })).toBeVisible();

  await expect(page.getByRole("heading", { name: "Run verified scenarios" })).toBeVisible();
  await expect(page.getByText(/replayed and re-verified—it is not live AI/i)).toBeVisible();
  const scenarioCards = page.locator(".scenario-score-card");
  await expect(scenarioCards).toHaveCount(5);
  await expect(scenarioCards.filter({ hasText: "Charge dispute" })).toHaveCount(1);
  await expect(page.getByRole("button", { name: "Run scenario" })).toHaveCount(5);
  await expect(page.locator("details.technical-details")).toHaveCount(0);

  await page.getByRole("button", { name: "Run all five" }).click();
  await expect(page.locator(".suite-progress strong")).toHaveText("5 of 5", { timeout: 25_000 });
  await expect(page.locator(".scenario-score-header b.pass")).toHaveCount(5);
  await expect(page.getByText("Replayed model fixture · verified").first()).toBeVisible();
  await expect(page.getByText("Scenario evaluation passed.", { exact: true })).toHaveCount(0);

  const firstScenario = scenarioCards.filter({ hasText: "Move a Lisbon stay" });
  await firstScenario.getByRole("button", { name: "Run scenario" }).click();
  await expect(page.getByRole("heading", { name: "changed", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/mock confirmation/i).last()).toBeVisible();
  await expect(page.getByText("Replayed scenario evaluation passed.", { exact: true })).toBeVisible();

  const provenance = page.getByTestId("narration-provenance");
  await expect(provenance).toHaveCount(5);
  await expect(provenance.first()).toHaveText("Replayed model fixture · verified");

  const technicalDetails = page.locator("details.technical-details");
  await expect(technicalDetails).toBeVisible();
  await expect(technicalDetails).not.toHaveAttribute("open", "");
  await technicalDetails.locator(":scope > summary").click();
  await expect(technicalDetails).toHaveAttribute("open", "");
  await expect(page.getByText("manage_reservation", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Replayed model fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic parser", { exact: true })).toBeVisible();
  await expect(page.getByRole("complementary").getByText(/PASS outcome changed/i)).toBeVisible();

  const metadataIsSeparated = await page.locator(".turn").evaluateAll((turns) =>
    turns.every((turn) => {
      const badge = turn.querySelector("[data-testid='narration-provenance']");
      const message = turn.querySelector("p");
      if (!badge || !message) return true;
      return badge.getBoundingClientRect().bottom <= message.getBoundingClientRect().top;
    }),
  );
  expect(metadataIsSeparated).toBe(true);
  await page.screenshot({ path: "test-results/demo-full.png", fullPage: true });

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileMetadataIsSeparated = await page.locator(".turn").evaluateAll((turns) =>
    turns.every((turn) => {
      const badge = turn.querySelector("[data-testid='narration-provenance']");
      const message = turn.querySelector("p");
      if (!badge || !message) return true;
      return badge.getBoundingClientRect().bottom <= message.getBoundingClientRect().top;
    }),
  );
  expect(mobileMetadataIsSeparated).toBe(true);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  await page.screenshot({ path: "test-results/demo-mobile.png", fullPage: true });
});
