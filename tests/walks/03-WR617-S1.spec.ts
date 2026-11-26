import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, complete, marker, needs, undo, visible } from "./ui.ts";

test("03 WR617.S1", async ({ page }) => {
  const row = await card(page, 3);
  await row.getByRole("button", { name: "Snooze", exact: true }).click();
  await page
    .getByRole("dialog", { name: "Snooze cards", exact: true })
    .getByRole("button", { name: /^1 hour/ })
    .click();
  const waiting = page.getByRole("region", { name: "In motion and waiting", exact: true });
  await visible(
    waiting.locator("[data-inbox-row]").filter({ has: page.locator("h3 a").filter({ hasText: marker(3) }) }),
  );
  await visible(row.getByRole("button", { name: "Wake", exact: true }));
  await undo(page);
  await visible(row.getByRole("button", { name: "Snooze", exact: true }));
  await complete(page, row);
  expect(
    await page
      .locator("[data-inbox-row]")
      .filter({ has: page.locator("h3 a").filter({ hasText: marker(3) }) })
      .count(),
  ).toBe(0);
  await undo(page);
  needs(true, "already auto-settled TEST WALK 3 card plus stored Working disposition evidence");
});
