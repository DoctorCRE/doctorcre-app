import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const phases = ["pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing"];
const names = [
  "Example Practitioner, DMD",
  "Example Northfield — Riverbendtown Purchase",
  "Example Imaging Partners – Second Office",
  "Example Dermatology Group",
  "Example Orthodontics – North / 5 Corners",
];
const deals = Array.from({ length: 70 }, (_, n) => ({
  id: `00000000-0000-4000-8000-${String(n + 1).padStart(12, "0")}`,
  name: `${names[n % names.length]} ${n + 1}`,
  owner: n % 2 ? "joe" : "dell",
  phase: phases[n % phases.length],
  operating_state: "active",
  open_actions: [],
}));

async function openBoard(page: Page) {
  const session = { actor: { slug: "joe" }, csrf_token: "synthetic-joe" };
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) =>
        new URL(request.url).pathname.endsWith("/prospects")
          ? Response.json({ count: 0, prospects: [] })
          : Response.json({
              schema_version: "local-deals-board.v2",
              actor: "joe",
              deals,
              closed_deals: [],
              lost_deals: [],
              accounts: [],
            }),
    },
  };
  const server = await startWorkerFixture({ assets: await appAssetSnapshot(), env });
  await page.route(/\/(mcp|api\/engine\/.*)$/, async (route) => {
    const request = route.request();
    const body = request.postData();
    const reply = await worker.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(body === null ? {} : { body }),
      }),
      env,
    );
    await route.fulfill({
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: Buffer.from(await reply.arrayBuffer()),
    });
  });
  await page.goto(`${server.origin}/deals?mode=live`);
  await page.locator("#prospectsLane").waitFor();
  await page.locator(".kanban-column[data-column] .kanban-card").first().waitFor();
  return server;
}

// Words in deal names and phase names that the browser split across two lines.
const splitWords = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll(".kanban-card .card-open, .kanban-column > h3 button > span")].flatMap((element) =>
      [...(element.textContent ?? "").matchAll(/\S+/g)].flatMap((word) => {
        const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
        const range = document.createRange();
        for (let offset = 0, node = walker.nextNode(); node; node = walker.nextNode()) {
          const length = node.textContent?.length ?? 0;
          if (word.index >= offset && word.index < offset + length) {
            range.setStart(node, word.index - offset);
            range.setEnd(node, Math.min(length, word.index - offset + word[0].length));
          }
          offset += length;
        }
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1 ? [word[0]] : [];
      }),
    ),
  );

const phaseLines = (page: Page) =>
  page
    .locator(".kanban-column > h3 button")
    .evaluateAll((buttons) =>
      buttons.map((button) => [
        button.getAttribute("aria-label"),
        [...button.children].every(
          (part) => part.getBoundingClientRect().height < 1.8 * Number.parseFloat(getComputedStyle(part).fontSize),
        ),
      ]),
    );

test("the Deals board keeps deals in reach on a phone and fits one screen on laptops", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const shots = "out/test-artifacts/deals-board-fit";
  await mkdir(shots, { recursive: true });

  for (const [width, height] of [
    [390, 844],
    [1200, 800],
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const)
    for (const theme of ["light", "dark"] as const)
      await t.test(`${width} ${theme}`, async (t) => {
        const context = await browser.newContext({ viewport: { width, height } });
        t.after(() => context.close());
        await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        const page = await context.newPage();
        const server = await openBoard(page);
        t.after(() => server.close());
        await page.screenshot({ path: `${shots}/board-${width}-${theme}.png` });

        assert.deepEqual(await splitWords(page), [], "no deal or phase name breaks inside a word");
        assert.ok(
          (await phaseLines(page)).every(([, oneLine]) => oneLine),
          "each phase name and count sit on one line",
        );
        if (width > 760) {
          assert.equal(
            await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight),
            true,
            "the board fits the screen without page scrolling",
          );
          const column = page.locator('.kanban-column[data-column="pending"]');
          const bottom = await column.evaluate((column) => {
            column.scrollTop = column.scrollHeight;
            return Math.round(column.getBoundingClientRect().bottom);
          });
          assert.ok(bottom <= height, "a full column ends on screen");
          assert.ok(await column.evaluate((column) => column.scrollTop > 0), "a full column scrolls inside itself");
          assert.equal(await column.locator("h3").isVisible(), true, "its phase name stays in view");
          return;
        }

        const board = await page
          .locator("#kanban")
          .evaluate((board) => ({ scrolls: board.scrollHeight > board.clientHeight + 1 }));
        assert.equal(board.scrolls, false, "the board scrolls with the page, not in its own box");
        const card = await page.locator(".kanban-column[data-column] .kanban-card").first().boundingBox();
        const nav = await page.locator("#appShell").boundingBox();
        assert.ok(card && nav && card.y + card.height <= nav.y, "the first deal is whole on the first screen");
      });
});
