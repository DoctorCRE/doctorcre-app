import { expect } from "e2e";
import { openSearch, reproTest } from "./support.mjs";

const test = reproTest();
test("QA-013 vendor search destination identifies Vendors", {
  tags: ["regression"],
  requires: ["browser"],
  retries: 0,
}, async ({ app, browser, screen }) => {
  await openSearch(app, browser);
  const row = screen.getByRole("listitem").filter({ hasText: "Demo Pensacola Buildout Contractors" });
  await row.getByRole("link", "Demo Pensacola Buildout Contractors", { exact: true }).focus();
  await browser.keyboard.press("Enter");
  await browser.waitForURL(/\/vendors/);
  await expect(browser.locator("#resultsTitle")).toHaveText("Vendors");
  await expect(browser.locator("#resultsTitle")).toBeVisible();
  await expect(screen.getByRole("heading", "Vendors", { exact: true })).toBeVisible();
  await expect(browser.locator(".footer")).toHaveText("DoctorCRE · Vendors");
  const context = await browser.evaluate(
    async (path) => (await import(path)).pageDocContext.snapshot(),
    "/js/doc-context.js",
  );
  expect(context.page).toBe("vendors");
  expect(context.label).toBe("Vendors");
});
