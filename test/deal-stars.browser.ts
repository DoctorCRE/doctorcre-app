import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium, settles } from "./browser-harness.mjs";

const alder = "Example Alder";
const birch = "Example Birch";
const cedar = "Example Cedar";
const deals = [alder, birch, cedar].map((name, n) => ({
  id: `00000000-0000-4000-8000-00000000000${n + 1}`,
  name,
  owner: "joe",
  phase: "pending",
  operating_state: "active",
  open_actions: [],
}));

// Cedar is starred, as the engine still stores and reads stars.
async function openDeals(page: Page) {
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
              deals: deals.map((d) => ({ ...d, starred: d.name === cedar })),
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
  await page
    .locator("#boardAsOf")
    .filter({ hasText: /^Updated / })
    .waitFor();
  return server;
}

const order = (page: Page, cards: string) =>
  page.locator(`${cards} .card-open`).evaluateAll((buttons) => buttons.map((b) => b.textContent));

test("a starred deal keeps its usual place and the board and list show no star", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const server = await openDeals(page);
  t.after(() => server.close());
  const tile = '.kanban-column[data-column="pending"] .kanban-card';
  await settles(async () => assert.deepEqual(await order(page, tile), [alder, birch, cedar]));
  assert.equal(await page.getByRole("button", { name: /^(un)?star /i }).count(), 0);

  await page.locator(tile, { hasText: cedar }).focus();
  await page.keyboard.press("Shift+F10");
  const menu = page.getByRole("menu", { name: `Actions for ${cedar}` });
  assert.deepEqual(await menu.getByRole("menuitem").allInnerTexts(), ["Open"]);
  await page.keyboard.press("Escape");

  await page.locator("#listView").click();
  await settles(async () => assert.deepEqual(await order(page, ".deal-list .kanban-card"), [alder, birch, cedar]));
  assert.equal(await page.getByRole("button", { name: /^(un)?star /i }).count(), 0);
});

test("star saves stay off until Deals saves use the engine", async () => {
  const session = { actor: { slug: "joe" }, csrf_token: "synthetic-joe" };
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async (key: string) => (key === "deals-from-engine" ? "on" : null) },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: { fetch: async () => assert.fail("a star must not reach the engine") },
  };
  const request = new Request(`https://app.example.test/api/engine/deals/${deals[0]?.id}/star`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-carr-csrf": session.csrf_token },
    body: JSON.stringify({ idempotency_key: crypto.randomUUID() }),
  });
  assert.equal((await worker.fetch(request, env)).status, 404);
});
