import { expect, test } from "@playwright/test";

test("runs the first scripted call and exposes the operation trace", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("heading", { name: /A travel call you can see thinking/i })).toBeVisible();
  await expect(page.getByText("Fictional AI demonstration", { exact: true })).toBeVisible();

  await page.getByRole("button", { name: /Move a Lisbon stay/i }).click();
  await page.getByRole("button", { name: /Start demo/i }).click();

  await expect(page.getByRole("heading", { name: "changed", exact: true })).toBeVisible({ timeout: 15_000 });
  await expect(page.getByText("manage_reservation", { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/mock confirmation/i).last()).toBeVisible();
  await expect(page.getByText(/PASS outcome changed/i)).toBeVisible();
  await page.screenshot({ path: "test-results/demo-full.png", fullPage: true });
});
