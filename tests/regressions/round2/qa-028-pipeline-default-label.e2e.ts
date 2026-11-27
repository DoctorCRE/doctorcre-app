import { expect } from "e2e";
import { reproTest } from "../support.mjs";

const test = reproTest();
test("QA-028 default Pipeline option names its pipeline scope", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser, screen }) => {
  await app.open("/clients?all=true&mode=live");
  await expect(browser.locator("#resultSummary")).toContainText(/\d+ clients/);
  const filters = browser.locator("#secondaryFilters > summary");
  if (await filters.isVisible()) await filters.tap();
  await expect(screen.getByRole("combobox", "Pipeline", { exact: true })).toBeVisible();
  await expect(screen.getByRole("combobox", "Pipeline", { exact: true })).toHaveValue("any");
  await expect(browser.locator("#filterC option:checked")).toContainText(/pipeline/i);
});
