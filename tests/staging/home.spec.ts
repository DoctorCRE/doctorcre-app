import { expect } from "@playwright/test";
import { journeyTest as test } from "./journey-fixture.ts";

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), async (dismiss) => {
    await dismiss.click();
  });
});

test("Charts selects Research, opens Deals and returns to Overview", async ({ page, rehearsal }) => {
  await page.goto("/?view=charts");
  const research = page.locator("#chartPhase").getByRole("button", { name: "Research", exact: true });
  await research.click();
  await expect(research).toHaveAttribute("aria-pressed", "true");
  await page.locator("#chartsSelection a").click();
  await expect(page.locator(`.card-open[data-open="${rehearsal.deal_id}"]:visible`)).toHaveText(rehearsal.deal_name);
  await page.goBack();
  await page.getByRole("link", { name: "Overview", exact: true }).click();
  await expect(page).toHaveURL("/");
  await expect(page.getByRole("region", { name: "Reminders", exact: true })).toBeVisible();
});

test("Home opens the deal from its overdue next step", async ({ page, rehearsal }) => {
  test.setTimeout(180_000);
  await page.goto(`/?card=${encodeURIComponent(rehearsal.home_item_id)}`);
  const dealUrl = `/deals?deal=${rehearsal.deal_id}&focus=next-step&step=${rehearsal.next_step_id}`;
  await page.locator(`[data-inbox-row="${rehearsal.home_item_id}"] h3 a[href="${dealUrl}"]`).click();
  await expect(page).toHaveURL(dealUrl);
  await expect(page.locator("#panelTitle")).toHaveText(rehearsal.deal_name);
});
