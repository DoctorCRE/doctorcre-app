import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";
import { lead, workspace } from "./leads-workspace-fixture.mjs";

const longMarket =
  "Northwest Synthetic County, the Greater Example River Valley Region and the Sample Lakes Metropolitan Service Area";

function shoutedBoard() {
  const board = workspace();
  board.leads = [
    lead(1, { doctor_name: "ACME CARE PARTNERS LLC", market: longMarket }),
    lead(2, { doctor_name: "O'NEIL FAMILY DENTISTRY OF EXAMPLE, P.C.", market: longMarket }),
    lead(3, { doctor_name: "SAMPLE SMILES DDS", market: longMarket }),
    lead(4, { doctor_name: "Example McKay Dental", market: "Mobile, AL" }),
  ];
  return board;
}

async function openLeads(t: test.TestContext, width: number) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: 800 }, reducedMotion: "reduce" });
  await routeLeads(page, { getBoard: shoutedBoard });
  // Today's read never answers, so the panel stays in its loading state.
  await page.route("**/api/engine/home/today**", () => {});
  await page.goto("http://localhost/leads");
  await page.locator("#leadBoard .lead-card").first().waitFor();
  return page;
}

async function openToday(page: Page) {
  const toggle = page.locator("#appTodayToggle");
  if ((await toggle.getAttribute("aria-expanded")) === "false") await toggle.click();
  await page.locator("#appToday").waitFor({ state: "visible" });
}

for (const width of [1280, 1440]) {
  test(`Leads reads all-caps names in title case at ${width}`, async (t) => {
    const page = await openLeads(t, width);
    assert.deepEqual(await page.locator("#leadBoard .lead-open").allInnerTexts(), [
      "Acme Care Partners LLC",
      "O'Neil Family Dentistry of Example, P.C.",
      "Sample Smiles DDS",
      "Example McKay Dental",
    ]);
    await page.locator("#leadBoard .lead-open").first().click();
    await page.locator("#detailTitle").filter({ hasText: "Acme Care Partners LLC" }).waitFor();
  });

  test(`Today waits on a quiet skeleton, not loading text, at ${width}`, async (t) => {
    const page = await openLeads(t, width);
    await openToday(page);
    await page.locator("#appTodayOwners.chip-bar").waitFor({ state: "attached" });
    for (const slot of ["#appScheduleSlot", "#appTodayNext"]) {
      assert.equal(await page.locator(slot).textContent(), "", `${slot} shows no text while loading`);
      assert.equal(await page.locator(`${slot} .skeleton-line`).first().isVisible(), true, `${slot} shows a skeleton`);
      assert.equal(await page.locator(slot).getAttribute("aria-busy"), "true", `${slot} says it is busy`);
    }
  });

  test(`Territory chips show the whole market name or truncate with it on hover and focus at ${width}`, async (t) => {
    const page = await openLeads(t, width);
    const chip = page.locator("#marketCounts [data-market]").first();
    const fit = () =>
      page.evaluate(() => {
        const strip = document.getElementById("marketCounts")?.getBoundingClientRect() ?? new DOMRect();
        const box = document.querySelector("#marketCounts [data-market]")?.getBoundingClientRect() ?? new DOMRect();
        return { inside: box.left >= strip.left - 0.5 && box.right <= strip.right + 0.5 };
      });
    assert.equal((await fit()).inside, true, "the chip stays inside the strip");
    assert.equal(await chip.getAttribute("aria-pressed"), "false");
    assert.equal(await chip.locator("b").textContent(), "3", "the count stays in the chip");
    assert.equal(await chip.getAttribute("data-market"), longMarket);
    const shown = (state: "hover" | "focus") =>
      chip.evaluate((node, state) => {
        const name = node.querySelector("span");
        const truncated = name !== null && name.scrollWidth > name.clientWidth;
        const tip = getComputedStyle(node, "::after");
        const box = node.getBoundingClientRect();
        return {
          state,
          truncated,
          fullName: !truncated || (tip.content === `"${node.dataset.market}"` && tip.display !== "none"),
          onScreen: !truncated || (box.top > 0 && Number.parseFloat(tip.maxWidth) > 0),
        };
      }, state);
    await chip.hover();
    const hover = await shown("hover");
    await page.mouse.move(0, 0);
    await chip.focus();
    const focus = await shown("focus");
    for (const result of [hover, focus])
      assert.deepEqual([result.fullName, result.onScreen], [true, true], JSON.stringify(result));
  });
}
