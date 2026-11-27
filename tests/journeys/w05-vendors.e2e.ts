import { test } from "@e2e-dev/web";
import { expect } from "e2e";
import { directoryFixture } from "../../test/fixtures/vendor-directory.synthetic.mjs";

// W5: the Vendors directory filters by owner and opens a vendor's full record.
test("W5 Vendors filters by owner and opens a vendor with its original entries", async ({ app, browser }) => {
  await browser.route("**/api/v1/business/**", (route) =>
    route.fulfill({ contentType: "application/json", body: JSON.stringify(directoryFixture(route.request.url)) }),
  );
  await app.open("/vendors?all=true");

  await expect(browser.locator("#resultSummary")).toHaveText(/^62 /);
  const filters = browser.locator("#secondaryFilters > summary");
  if (await filters.isVisible()) await filters.tap();
  await browser.locator('[data-owner="dell"]').tap();
  await expect(browser.locator("#resultSummary")).toHaveText(/^31 /);
  await browser.waitForURL(/owner=dell/);
  await browser.locator('[data-owner="all"]').tap();
  await expect(browser.locator("#resultSummary")).toHaveText(/^62 /);

  await browser.locator(".record-row").first().tap();
  await expect(browser.locator("#recordPanel")).toBeVisible();
  // A vendor opens as a card beside the table; on a phone the card covers it as a dialog.
  const phone = await browser.evaluate(() => innerWidth < 768);
  await expect(browser.locator("#recordPanel")).toHaveAttribute("role", phone ? "dialog" : "complementary");
  await expect(browser.locator("#recordBody")).toContainText("Suggested introductions");
  const intro = browser.locator('[data-details-key="intro-demo-intro"]');
  await browser.locator('[data-details-key="intro-demo-intro"] summary').tap();
  await expect(intro).toContainText("Original synthetic introduction entry");

  await browser.locator('#recordPanel [aria-label="Close record"]').tap();
  await expect(browser.locator("#recordPanel")).toBeHidden();
  await expect(browser.locator("#resultsTitle")).toHaveText("Vendors");
});
