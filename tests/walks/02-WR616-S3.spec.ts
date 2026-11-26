import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, needs, noOverflow, visible } from "./ui.ts";

test("02 WR616.S3", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await card(page);
    await visible(page.locator(".home-slice", { has: row }).getByRole("heading", { level: 2 }));
    const link = row.locator("h3 a");
    const href = await link.getAttribute("href");
    needs(!href?.startsWith("/deals"), "Home card linked to a designated test deal");
    const homeUrl = page.url();
    await link.click();
    await visible(page.locator("#recordPanel"));
    await page.goBack();
    expect(page.url() === homeUrl).toBe(true);
    await page.reload();
    expect(page.url() === homeUrl).toBe(true);
    await noOverflow(page);
  }
});
