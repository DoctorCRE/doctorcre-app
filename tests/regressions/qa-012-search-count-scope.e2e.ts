import { expect } from "e2e";
import { openSearch, reproTest } from "./support.mjs";

const test = reproTest();
test("QA-012 the count matches the visible results", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser }) => {
  await openSearch(app, browser);
  for (const chip of await browser.locator("#searchChips button").all()) {
    const label = await chip.textContent();
    if (!/^(Leads|Organizations)$/.test(label ?? "")) await chip.tap();
  }
  await expect(browser.locator("#searchResults [data-group]")).toHaveCount(2);
  await expect(browser.locator("#searchCount")).toHaveText(`${await browser.locator(".search-row").count()} results`);
});
