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

test("Clients search, clear and a column sort keep the place in the URL", async ({ page }) => {
  await openAllClients(page);
  await page.locator("#searchInput").fill("V2 no matching client 35f9009c");
  await expect(page.locator(".record-row")).toHaveCount(0);
  await page.getByRole("button", { name: "Clear all filters", exact: true }).click();
  await expect(page.locator(".record-row").first()).toBeVisible();
  await expect(page).toHaveURL(/all=true/);
  await page.locator('[data-column-sort="status"]').click();
  await expect(page).toHaveURL(/sort=status/);
  await expect(page.locator('[data-column-sort="status"]')).toHaveAttribute("aria-pressed", "true");
});

test("Clients open a complete record and return to results", async ({ page }) => {
  await openAllClients(page);
  // The row's open deal name opens the deal, so the client is opened by its own name.
  await page.locator(".record-row .row-name").first().click();
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
  const openDeal = page.locator('#tableFilters [data-status-filter="active_deal"]');
  await openDeal.click();
  await expect(page).toHaveURL(/status=active_deal/);
  await scope.getByRole("button", { name: "All", exact: true }).click();
  await expect(openDeal).toHaveAttribute("aria-pressed", "true");
  await openDeal.click();
  await expect(page).not.toHaveURL(/status=/);
  await expect(page.locator(".record-row").first()).toBeVisible();
});
