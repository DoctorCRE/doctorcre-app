import { expect } from "@playwright/test";
import { journeyTest as test } from "./journey-fixture.ts";
import { parkedDeals } from "./journey-flows.mjs";

test.describe.configure({ retries: 0 });

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), async (dismiss) => {
    await dismiss.click();
  });
});

test("Deals switches board and list views and opens the rehearsal deal", async ({ page, rehearsal }) => {
  const card = page.locator(`.card-open[data-open="${rehearsal.deal_id}"]:visible`);
  await page.goto("/deals");
  await expect(card).toBeVisible();
  await page.getByRole("button", { name: "List", exact: true }).click();
  await expect(page.locator("#listView")).toHaveAttribute("aria-pressed", "true");
  await page.getByRole("button", { name: "Board", exact: true }).click();
  await expect(page.locator("#boardView")).toHaveAttribute("aria-pressed", "true");
  await card.click();
  await expect(page.locator("#recordPanel")).toBeVisible();
  await expect(page.locator("#panelTitle")).toHaveText(rehearsal.deal_name);
  await page.getByRole("button", { name: "Back to deals", exact: true }).click();
  await expect(page.locator("#recordPanel")).toBeHidden();
});

test("Deals opens the parked section and Today sidebar", async ({ page, rehearsal }) => {
  await parkedDeals(page, page.locator(`.card-open[data-open="${rehearsal.deal_id}"]:visible`));
});

test("Deal detail expands update history and preserves it through refresh", async ({ page, rehearsal }) => {
  test.setTimeout(420000);
  await page.goto(`/deals?deal=${rehearsal.deal_id}`);
  await expect(page.locator("#panelTitle")).toHaveText(rehearsal.deal_name);
  const history = page.locator(".updates-history");
  await expect(history).toHaveCount(1);
  await history.locator(":scope > summary").click();
  await expect(history.locator(".deal-note")).toHaveCount(2);
  await expect(history.locator(".deal-note p")).toHaveText(rehearsal.notes.toReversed());
  await expect(history.locator(".deal-note").first()).toBeVisible();
  const observed = await page.locator("#detailUpdated").getAttribute("datetime");
  await page.getByRole("button", { name: "Refresh deal", exact: true }).click();
  await expect(page.locator("#detailUpdated")).not.toHaveAttribute("datetime", observed || "", { timeout: 27000 });
  await expect(history).toHaveAttribute("open", "");
});

test("Deal card omits Dates, Full record and outlook controls", async ({ page, rehearsal }) => {
  test.setTimeout(420000);
  await page.goto(`/deals?deal=${rehearsal.deal_id}`);
  await expect(page.locator("#panelTitle")).toHaveText(rehearsal.deal_name);
  await expect(page.locator(".deal-dates,.full-record,[data-jev-deal],#dealDateDialog")).toHaveCount(0);
});

test("An unsaved deal note clears when the deal reopens", async ({ page, rehearsal }) => {
  test.setTimeout(420000);
  await page.goto(`/deals?deal=${rehearsal.deal_id}`);
  await page.locator("#detailNextStepEditor > summary").click();
  await page.locator("#detailNoteEditor > summary").click();
  const update = page.getByLabel("Note", { exact: true });
  await expect(update).toHaveValue("");
  await update.fill("Synthetic unsaved review draft");
  await page.getByRole("button", { name: "Back to deals", exact: true }).click();
  await page.goto(`/deals?deal=${rehearsal.deal_id}`);
  await expect(update).toHaveValue("");
});
