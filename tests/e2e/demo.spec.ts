import { expect, test } from "@playwright/test";

test("presents one clear demo flow and reveals technical details on demand", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /Run a travel-support call/i })).toBeVisible();
  await expect(page.getByText("Fictional AI demo", { exact: true })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Call demo" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Agent trace" })).toBeVisible();

  const scenarioCards = page.locator(".scenario-card--compact");
  await expect(scenarioCards).toHaveCount(5);
  await expect(scenarioCards.filter({ hasText: "Charge dispute" })).toHaveCount(1);

  await scenarioCards.filter({ hasText: "Charge dispute" }).click();
  await expect(page.locator(".selected-scenario p")).toHaveText("Goal: Escalate a disputed cancellation charge");
  await scenarioCards.filter({ hasText: "Move a Lisbon stay" }).click();
  await expect(page.locator(".selected-scenario p")).toHaveText("Goal: Change dates and choose an option");

  const runDemo = page.getByRole("button", { name: /Run demo/i });
  await expect(runDemo).toBeVisible();
  await expect(page.locator("details.technical-details")).toHaveCount(0);

  await runDemo.click();

  await expect(page.getByRole("heading", { name: "changed", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText(/mock confirmation/i).last()).toBeVisible();
  await expect(page.getByText("Scenario evaluation passed.", { exact: true })).toBeVisible();
  await expect(page.getByText("Reservation lookup", { exact: true })).toBeVisible();
  await expect(page.getByText("Replacement options quoted", { exact: true })).toBeVisible();
  await expect(page.getByText("Date change confirmed", { exact: true })).toBeVisible();

  const provenance = page.getByTestId("narration-provenance");
  await expect(provenance).toHaveCount(5);
  await expect(provenance.first()).toHaveText("Model fixture · verified");

  const technicalDetails = page.locator("details.technical-details");
  await expect(technicalDetails).toBeVisible();
  await expect(technicalDetails).not.toHaveAttribute("open", "");
  await technicalDetails.locator(":scope > summary").click();
  await expect(technicalDetails).toHaveAttribute("open", "");
  await expect(page.getByText("manage_reservation", { exact: true }).first()).toBeVisible();
  await expect(page.getByText("Verified model fixture", { exact: true })).toBeVisible();
  await expect(page.getByText("Deterministic parser", { exact: true })).toBeVisible();
  await expect(page.getByText(/PASS outcome changed/i)).toBeVisible();

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
