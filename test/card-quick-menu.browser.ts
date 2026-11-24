import assert from "node:assert/strict";
import test from "node:test";
import type { Locator, Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

// Synthetic fixture data only: the seed's demo deals, with one parked so a list
// row carries a second control (Revive) for the menu to offer.
const TILE = { id: "d01", name: "Demo Dental North", labels: ["Open"] };
const PARKED = { id: "d02", name: "Demo Pediatrics East", labels: ["Open", "Revive"] };

async function openDeals(page: Page, origin: string, theme: string, view: "board" | "list") {
  await page.addInitScript(
    (theme) => localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme })),
    theme,
  );
  await page.route("**/data/board-seed.json", async (route) => {
    const seed = await (await route.fetch()).json();
    const deal = seed.deals.find((row: { id: string }) => row.id === PARKED.id);
    Object.assign(deal, {
      operating_state: "parked",
      parking_reason: "other",
      parking_note: "Waiting on the sample lease",
    });
    await route.fulfill({ json: seed });
  });
  await page.goto(`${origin}/deals?mode=fixture`);
  await page.locator(`#kanban .kanban-card[data-id="${TILE.id}"]`).first().waitFor();
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  if (view === "list") {
    await page.locator("#listView").click();
    await page.locator("#parkedToggle").click();
    await page.locator(`#kanban .deal-row[data-id="${PARKED.id}"]`).waitFor();
  }
}

const menuFor = (page: Page, name: string) => page.getByRole("menu", { name: `Actions for ${name}` });
const focusedText = (page: Page) => page.evaluate(() => document.activeElement?.textContent?.trim() ?? "");

// A point on the card that is the card's own surface, not one of its controls.
async function plainPoint(card: Locator) {
  const point = await card.evaluate((element) => {
    const box = element.getBoundingClientRect();
    const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11];
    const points = steps.flatMap((row) =>
      steps.map((column) => ({ x: box.left + (box.width * column) / 12, y: box.top + (box.height * row) / 12 })),
    );
    const plain = points.find(({ x, y }) => {
      const hit = document.elementFromPoint(x, y);
      return (
        hit && element.contains(hit) && !hit.closest("button,a,input,select,textarea,details,.deal-vendor-details")
      );
    });
    return plain ? { x: Math.round(plain.x), y: Math.round(plain.y) } : null;
  });
  assert.ok(point, "the card has a plain surface to press");
  return point;
}

// A visible point away from the menu, the cards and every control.
async function outsidePoint(page: Page) {
  const point = await page.evaluate(() => {
    const steps = [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15];
    const points = steps.flatMap((row) =>
      steps.map((column) => ({ x: (innerWidth * column) / 16, y: (innerHeight * row) / 16 })),
    );
    return (
      points.find(({ x, y }) => {
        const hit = document.elementFromPoint(x, y);
        return (
          hit && !hit.closest('.kanban-card,[role="menu"],button,a,input,select,textarea,summary,label,nav,dialog')
        );
      }) ?? null
    );
  });
  assert.ok(point, "the page has a plain surface outside the menu");
  return { x: Math.round(point.x), y: Math.round(point.y) };
}

async function rightClick(page: Page, card: Locator) {
  // A repaint can reset the board's scroll; press only a card that is on screen.
  await card.scrollIntoViewIfNeeded();
  const point = await plainPoint(card);
  await page.mouse.click(point.x, point.y, { button: "right" });
}

async function assertInsideViewport(page: Page, menu: Locator) {
  const box = await menu.boundingBox();
  assert.ok(box, "the menu is rendered");
  const size = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }));
  assert.ok(box.x >= 0 && box.y >= 0, `menu starts inside the viewport: ${JSON.stringify(box)}`);
  assert.ok(
    box.x + box.width <= size.width && box.y + box.height <= size.height,
    `menu ends inside the viewport: ${JSON.stringify(box)}`,
  );
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
}

test("right-click on a Deals card opens a menu of that card's own controls", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      for (const view of ["board", "list"] as const) {
        const page = await browser.newPage({
          viewport: { width, height: 900 },
          colorScheme: theme,
          reducedMotion: "reduce",
        });
        try {
          await openDeals(page, server.origin, theme, view);
          const kanban = page.locator("#kanban");
          const subject = view === "board" ? TILE : PARKED;
          const card = kanban.locator(
            `${view === "board" ? ".kanban-card:not(.deal-row)" : ".deal-row"}[data-id="${subject.id}"]`,
          );
          await card.scrollIntoViewIfNeeded();

          if (view === "list") {
            await rightClick(page, kanban.locator(`.deal-row[data-id="${TILE.id}"]`));
            assert.deepEqual(await menuFor(page, TILE.name).getByRole("menuitem").allInnerTexts(), TILE.labels);
            await page.keyboard.press("Escape");
          }

          // Right-click opens the card's menu with its own controls, focused on the first.
          await rightClick(page, card);
          const menu = menuFor(page, subject.name);
          await menu.waitFor();
          assert.equal(await page.getByRole("menu").count(), 1, "only one menu exists");
          assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), subject.labels);
          assert.equal(await focusedText(page), "Open");
          await assertInsideViewport(page, menu);
          assert.equal(await kanban.locator('[data-lifted="true"]').count(), 0);

          // Arrow keys move focus and wrap at both ends.
          const labels = subject.labels;
          await page.keyboard.press("ArrowDown");
          assert.equal(await focusedText(page), labels[1 % labels.length]);
          await page.keyboard.press("ArrowDown");
          assert.equal(await focusedText(page), labels[2 % labels.length]);
          await page.keyboard.press("ArrowUp");
          assert.equal(await focusedText(page), labels[1 % labels.length]);
          await page.keyboard.press("Home");
          assert.equal(await focusedText(page), "Open");
          await page.keyboard.press("ArrowUp");
          assert.equal(await focusedText(page), labels.at(-1));
          assert.equal(await kanban.locator('[data-lifted="true"]').count(), 0, "menu keys never lift a card");

          // A repaint while the menu is open waits; the board repaints once it closes.
          await card.evaluate((element) => {
            element.dataset.beforeRepaint = "true";
          });
          await page.evaluate(() =>
            document.querySelector<HTMLButtonElement>('#boardChips [data-filter="all"]')?.click(),
          );
          await page.waitForTimeout(100);
          assert.equal(await menu.isVisible(), true, "the repaint does not remove the menu");
          assert.equal(await kanban.locator('[data-before-repaint="true"]').count(), 1, "the board waits for the menu");

          // Escape closes the menu and returns focus to the card.
          await page.keyboard.press("Escape");
          assert.equal(await page.getByRole("menu").count(), 0);
          await kanban.locator('[data-before-repaint="true"]').waitFor({ state: "detached" });
          assert.equal(
            await page.evaluate(() => {
              const active = document.activeElement;
              return active instanceof HTMLElement && active.matches(".kanban-card") ? active.dataset.id : null;
            }),
            subject.id,
          );

          // A pointer press outside closes it without acting.
          await rightClick(page, card);
          await menu.waitFor();
          const outside = await outsidePoint(page);
          await page.mouse.click(outside.x, outside.y);
          assert.equal(await page.getByRole("menu").count(), 0);
          assert.equal(new URL(page.url()).searchParams.get("deal"), null);

          // Enter on Open opens that deal's workspace, as clicking its name does.
          await rightClick(page, card);
          await menu.waitFor();
          assert.equal(await focusedText(page), "Open");
          await page.keyboard.press("Enter");
          await page.waitForURL((url) => url.searchParams.get("deal") === subject.id);
          await page.locator("#recordPanel").waitFor({ state: "visible" });
          assert.equal(await page.getByRole("menu").count(), 0);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        } finally {
          await page.close();
        }
      }
});

test("a long-press on a phone opens the card menu without opening the deal or dragging", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const theme of ["light", "dark"] as const)
    for (const view of ["board", "list"] as const) {
      const context = await browser.newContext({
        viewport: { width: 390, height: 844 },
        hasTouch: true,
        isMobile: true,
        colorScheme: theme,
        reducedMotion: "reduce",
      });
      const page = await context.newPage();
      try {
        await openDeals(page, server.origin, theme, view);
        const subject = view === "board" ? TILE : PARKED;
        const card = page.locator(
          `#kanban ${view === "board" ? ".kanban-card:not(.deal-row)" : ".deal-row"}[data-id="${subject.id}"]`,
        );
        await card.scrollIntoViewIfNeeded();
        const point = await plainPoint(card);

        const cdp = await context.newCDPSession(page);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [point] });
        await page.waitForTimeout(800);
        await cdp.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });

        const menu = menuFor(page, subject.name);
        await menu.waitFor();
        await page.waitForTimeout(200);
        assert.equal(await page.getByRole("menu").count(), 1, "one long-press opens exactly one menu");
        assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), subject.labels);
        assert.equal(new URL(page.url()).searchParams.get("deal"), null, "the long-press does not open the deal");
        assert.equal(await page.locator("#recordPanel").isVisible(), false);
        assert.equal(await page.locator('#kanban [data-dragging="true"]').count(), 0);
        assert.equal(await page.locator("#completionDialog[open]").count(), 0, "no move dialog");
        await assertInsideViewport(page, menu);

        // A tap outside closes the menu; a short tap on the card still opens the deal.
        const outside = await outsidePoint(page);
        await page.touchscreen.tap(outside.x, outside.y);
        assert.equal(await page.getByRole("menu").count(), 0);
        await page.touchscreen.tap(point.x, point.y);
        await page.waitForURL((url) => url.searchParams.get("deal") === subject.id);
        assert.equal(await page.getByRole("menu").count(), 0);
      } finally {
        await context.close();
      }
    }
});
