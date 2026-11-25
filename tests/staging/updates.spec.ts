import { expect, test } from "@playwright/test";

test.describe.configure({ retries: 0 });

test("Updates reads the feed and Settings reads quiet hours without a version number", async ({ page }) => {
  await page.goto("/updates");
  await page.addLocatorHandler(page.getByRole("button", { name: "Dismiss morning brief" }), async (dismiss) => {
    await dismiss.click();
  });
  await expect(page.locator("#feedState")).not.toHaveAttribute("data-state", "loading", { timeout: 27000 });
  await expect(page.locator("#feedState")).not.toHaveAttribute("data-state", "unavailable");
  await page.goto("/settings");
  await expect(page.locator("#prefForm")).toBeVisible({ timeout: 27000 });
  await expect(page.locator("#prefForm")).not.toContainText(/version\s*\d/i);
  const original = await page.locator("#quietStart").inputValue();
  await page.locator("#quietStart").fill("11:59 PM");
  await page.locator("#quietStart").fill(original);
});
