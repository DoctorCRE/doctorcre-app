import { expect } from "e2e";
import { openSearch, reproTest } from "./support.mjs";

const test = reproTest();
test("QA-007 disabling initially pressed Leads retains the other scopes", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const initial = await browser.locator(".search-row").count();
  const leads = screen.getByRole("button", "Leads");
  const count = await browser.locator("[data-group=leads] .search-row").count();
  await expect(leads).toHaveAttribute("aria-pressed", "true");
  await leads.tap();
  await expect(leads).toHaveAttribute("aria-pressed", "false");
  await expect(browser.locator("#searchCount")).toHaveText(`${initial - count} results`);
  await expect(screen.getByRole("button", "Organizations")).toHaveAttribute("aria-pressed", "true");
  for (const chip of await browser.locator("#searchChips button").all()) {
    if ((await chip.getAttribute("aria-pressed")) === "true") await chip.tap();
  }
  await expect(browser.locator("#searchCount")).toHaveText("0 results");
  await expect.poll(() => browser.evaluate(() => new URL(location.href).searchParams.get("kinds"))).toBe("none");
  await browser.reload();
  await expect(browser.locator("#searchCount")).toHaveText("0 results");
  await screen.getByRole("button", "Leads").tap();
  await expect(browser.locator("#searchCount")).toHaveText(`${count} ${count === 1 ? "result" : "results"}`);
});
