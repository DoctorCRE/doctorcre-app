import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, complete, home, undo } from "./ui.ts";

test("14 WR617.S14", async ({ page }) => {
  const row = await card(page, 14);
  const id = await complete(page, row);
  const check = await page.context().newPage();
  try {
    await home(check);
    expect(await check.locator(`[data-inbox-row=${JSON.stringify(id)}]`).count()).toBe(0);
    for (const name of ["Done today", "Earlier and undated completions"]) {
      expect(await check.getByRole("region", { name, exact: true }).count()).toBe(0);
    }
  } finally {
    await check.close();
    await undo(page);
  }
});
