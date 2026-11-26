import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, marker, needs, undo, visible } from "./ui.ts";

test("33 unit:inbox-card-actions", async ({ page }) => {
  for (const width of [390, 1440]) {
    await page.setViewportSize({ width, height: 900 });
    const row = await card(page, 33);
    const unrelated = page
      .locator("[data-inbox-row]")
      .filter({ has: page.locator("h3 a").filter({ hasText: marker(33) }) })
      .nth(1);
    needs(!(await unrelated.count()), "second TEST WALK 33 card");
    const before = await unrelated.textContent();
    await row.getByRole("button", { name: "Snooze", exact: true }).click();
    await page
      .getByRole("dialog", { name: "Snooze cards", exact: true })
      .getByRole("button", { name: /^Tomorrow/ })
      .click();
    await visible(row.getByRole("button", { name: "Wake", exact: true }));
    expect((await unrelated.textContent()) === before).toBe(true);
    await undo(page);
    await visible(row.getByRole("button", { name: "Snooze", exact: true }));
  }
});
