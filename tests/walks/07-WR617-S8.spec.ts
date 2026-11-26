import { expect } from "@playwright/test";
import { test } from "./privacy.ts";
import { card, needs, visible } from "./ui.ts";

test("07 WR617.S8", async ({ page }) => {
  const row = await card(page, 7);
  await row.locator("h3 a").click();
  const review = row.locator(".home-inline-review");
  await visible(review.getByRole("button", { name: "Save draft", exact: true }));
  const message = review.getByRole("textbox", { name: "Message", exact: true });
  const original = await message.inputValue();
  const updated = `${original}\nTEST WALK 7 saved-version check`;
  await message.fill(updated);
  await review.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect
    .poll(() => review.textContent().then((text) => (text ?? "").includes("Saved as a draft. Nothing was sent.")))
    .toBe(true);
  await page.reload();
  const restored = await card(page, 7);
  await restored.locator("h3 a").click();
  const saved = restored.getByRole("textbox", { name: "Message", exact: true });
  await visible(saved);
  expect((await saved.inputValue()) === updated).toBe(true);
  await saved.fill(original);
  await restored.getByRole("button", { name: "Save draft", exact: true }).click();
  needs(true, "queued schedule readback linked to the same TEST WALK 7 draft; Home inline review exposes no schedule");
});
