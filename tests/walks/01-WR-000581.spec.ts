import assert from "node:assert/strict";
import { expect, type Locator } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, complete, marker, needs, reloadCard, undo } from "./ui.ts";

test("01 WR-000581", async ({ page }) => {
  const row = await card(page, 1);
  const dealOf = (target: Locator) =>
    target
      .locator("h3 a")
      .getAttribute("href")
      .then((href) => new URL(href ?? "", "https://app.doctorcre.com").searchParams.get("deal"));
  const deal = await dealOf(row);
  expect(Boolean(deal)).toBe(true);
  const siblings = page
    .locator("[data-inbox-row]")
    .filter({ has: page.locator("h3 a").filter({ hasText: marker(1) }) });
  needs((await siblings.count()) < 2, "two TEST WALK 1 actions on the same test deal");
  const sibling = siblings.nth(1);
  expect((await dealOf(sibling)) === deal).toBe(true);
  expect(await sibling.getByRole("button", { name: "Mark done", exact: true }).isVisible()).toBe(true);
  const id = await complete(page, row);
  const check = await page.context().newPage();
  try {
    const stored = await reloadCard(check, id);
    expect(await stored.getByRole("button", { name: "Mark done", exact: true }).count()).toBe(0);
    const siblingId = await sibling.getAttribute("data-inbox-row");
    assert.ok(siblingId);
    const storedSibling = await reloadCard(check, siblingId);
    expect(await storedSibling.getByRole("button", { name: "Mark done", exact: true }).isVisible()).toBe(true);
  } finally {
    await check.close();
  }
  await undo(page);
  await reloadCard(page, id);
  expect(
    await page
      .locator("[data-current] button")
      .filter({ hasText: /^Mark done$/ })
      .isVisible(),
  ).toBe(true);
});
