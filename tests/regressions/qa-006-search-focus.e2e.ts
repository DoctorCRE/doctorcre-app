import { expect } from "e2e";
import { openSearch, reproTest } from "./support.mjs";

const test = reproTest();
test("QA-006 changing Organizations scope retains visible keyboard focus", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const leadCount = await browser.locator("[data-group=leads] .search-row").count();
  const orgCount = await browser.locator("[data-group=organizations] .search-row").count();
  const countLabel = (count: number) => `${count} ${count === 1 ? "result" : "results"}`;
  for (const chip of await browser.locator("#searchChips button").all()) {
    if ((await chip.textContent()) !== "Leads") await chip.tap();
  }
  await expect(browser.locator("#searchCount")).toHaveText(countLabel(leadCount));
  const organizations = screen.getByRole("button", "Organizations");
  await organizations.focus();
  await organizations.press("Space");
  await expect(browser.locator("#searchCount")).toHaveText(countLabel(leadCount + orgCount));
  await expect(organizations).toBeFocused();
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const active = document.activeElement;
        if (!active) return false;
        const style = getComputedStyle(active);
        return style.outlineStyle !== "none" && parseFloat(style.outlineWidth) > 0;
      }),
    )
    .toBe(true);
  await expect
    .poll(() =>
      browser.evaluate(() => {
        const rect = document.activeElement?.getBoundingClientRect();
        return Boolean(rect && rect.top >= 0 && rect.bottom <= innerHeight);
      }),
    )
    .toBe(true);
  await organizations.press("Enter");
  await expect(organizations).toHaveAttribute("aria-pressed", "false");
  await expect(organizations).toBeFocused();
  await expect(browser.locator("#searchCount")).toHaveText(countLabel(leadCount));
  await browser.keyboard.press("Tab");
  await expect(browser.locator("[data-chip=deals]")).toBeFocused();
});
