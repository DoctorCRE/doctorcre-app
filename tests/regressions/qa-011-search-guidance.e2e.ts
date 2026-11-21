import { expect } from "e2e";
import { openSearch, reproTest } from "./support.mjs";

const test = reproTest();
test("QA-011 results show clear names without candidate instructions", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser }) => {
  await openSearch(app, browser);
  await expect(browser.locator("#searchResults")).not.toContainText(/call catch-me-up|this verb|Multiple matches/);
  await expect(browser.locator("#searchResults a").first()).toBeVisible();
});
