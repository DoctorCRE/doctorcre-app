import { expect, test } from "@playwright/test";
import { withJourneyFixture } from "./journey-fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), async (dismiss) => {
    await dismiss.click();
  });
});

test("V2-F03: Charts navigation opens, selects and returns to Overview", async ({ page }) => {
  await page.goto("/?view=charts");
  await expect(page.locator(".chart-card").first()).toBeVisible();
  await page.locator(".chart-pick").first().click();
  await expect(page.locator('.chart-pick[aria-pressed="true"]').first()).toBeVisible();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("region", { name: "Reminders", exact: true })).toBeVisible();
});

test("Home opens the deal from its overdue next step", async ({ page }) => {
  test.setTimeout(180_000);
  await withJourneyFixture(async (fixture) => {
    await page.goto(`/?card=${encodeURIComponent(fixture.home_item_id)}`);
    const dealUrl = `/deals?deal=${fixture.deal_id}&focus=next-step&step=${fixture.next_step_id}`;
    await page.locator(`[data-inbox-row="${fixture.home_item_id}"] h3 a[href="${dealUrl}"]`).click();
    await expect(page).toHaveURL(dealUrl);
    await expect(page.locator("#panelTitle")).toHaveText(fixture.deal_name);
  });
});
