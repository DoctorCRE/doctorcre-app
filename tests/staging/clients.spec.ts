import { expect, type Page, test } from "@playwright/test";

// Clients opens on tiles; All clients is the tile that opens the whole list.
async function openAllClients(page: Page) {
  await page.goto("/clients");
  await page.locator("a.directory-tile", { hasText: "All clients" }).click();
  await expect(page.locator(".record-row").first()).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), async (dismiss) => {
    await dismiss.click();
  });
});

test("Clients search, reset, sort and refresh preserve URL filters", async ({ page }) => {
  await openAllClients(page);
  await page.locator("#searchInput").fill("V2 no matching client 35f9009c");
  await expect(page.locator(".record-row")).toHaveCount(0);
  await page.locator("#resetFilters").click();
  await expect(page.locator(".record-row").first()).toBeVisible();
  await page.locator("#sortSelect").selectOption("last_deal_desc");
  await expect(page).toHaveURL(/sort=last_deal_desc/);
  await page.locator("#refreshList").click();
  await expect(page.locator("#sortSelect")).toHaveValue("last_deal_desc");
});

test("Clients open a complete record and return to results", async ({ page }) => {
  await openAllClients(page);
  await page.locator(".record-row").first().click();
  await expect(page.locator("#recordPanel")).toBeVisible();
  await expect(page.locator("#recordTitle")).not.toHaveText("Opening…");
  await expect(page.locator("#recordBody")).not.toBeEmpty();
  await page.getByRole("button", { name: "Close record", exact: true }).click();
  await expect(page.locator("#recordPanel")).toBeHidden();
  await expect(page.locator(".record-row").first()).toBeVisible();
});

test("Clients apply owner and business filters, then return to all records", async ({ page }) => {
  await openAllClients(page);
  const scope = page.getByRole("group", { name: "Record scope", exact: true });
  await scope.getByRole("button", { name: "Joe", exact: true }).click();
  await expect(scope.getByRole("button", { name: "Joe", exact: true })).toHaveAttribute("aria-pressed", "true");
  await page.locator("#filterA").selectOption({ index: 1 });
  await scope.getByRole("button", { name: "All", exact: true }).click();
  const today = page.getByRole("button", { name: "Today sidebar", exact: true });
  if ((await today.getAttribute("aria-expanded")) === "true") await today.click();
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  await expect(clear).toBeVisible();
  await clear.click();
  await expect(page.locator(".record-row").first()).toBeVisible();
});
