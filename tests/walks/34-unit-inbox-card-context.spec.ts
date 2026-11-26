import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, home, needs, visible } from "./ui.ts";

test("34 unit:inbox-card-context", async ({ page }) => {
  const row = await card(page);
  const id = await row.getAttribute("data-inbox-row");
  const link = row.locator("h3 a");
  const href = await link.getAttribute("href");
  needs(!href?.startsWith("/deals"), "test inbox card linked to a deal");
  if (!href || !id) throw Error("Test inbox card needs an id and a source link");
  const dealId = new URL(href, "https://app.doctorcre.com").searchParams.get("deal");
  expect(Boolean(dealId)).toBe(true);
  await link.click();
  await visible(page.locator("#recordPanel"));
  expect(new URL(page.url()).searchParams.get("deal") === dealId).toBe(true);
  await home(page);
  const restored = page.locator(`[data-inbox-row=${JSON.stringify(id)}] h3 a`);
  expect((await restored.getAttribute("href")) === href).toBe(true);
});
