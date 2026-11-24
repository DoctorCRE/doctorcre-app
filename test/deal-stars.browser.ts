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

async function openDeals(page: Page, actor: string, stars: Map<string, Set<string>>, fail: { star: boolean }) {
  const session = { actor: { slug: actor }, csrf_token: `synthetic-${actor}` };
  const mine = stars.get(actor) ?? new Set<string>();
  stars.set(actor, mine);
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const star = /^\/api\/engine\/deals\/(?<id>[^/]+)\/(?<verb>star|unstar)$/.exec(path)?.groups;
        if (star?.id && request.method === "POST") {
          assert.equal(request.headers.get("x-carr-csrf"), session.csrf_token);
          assert.match((await request.json()).idempotency_key, /^[\da-f-]{36}$/);
          if (fail.star) return Response.json({ error: "database_unavailable" }, { status: 503 });
          const { id, verb } = star;
          if (verb === "star") mine.add(id);
          else mine.delete(id);
          return Response.json({ deal_id: id, starred: verb === "star" });
        }
        if (path.endsWith("/prospects")) return Response.json({ count: 0, prospects: [] });
        return Response.json({
          schema_version: "local-deals-board.v2",
          actor,
          deals: deals.map((d) => ({ ...d, starred: mine.has(d.id) })),
          closed_deals: [],
          lost_deals: [],
          accounts: [],
        });
      },
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
const boardOrder = (page: Page) => order(page, '.kanban-column[data-column="pending"] .kanban-card');
const starButton = (page: Page, name: string) => page.getByRole("button", { name: `Star ${name}`, exact: true });

async function expectOrder(read: () => Promise<(string | null)[]>, expected: string[]) {
  await settles(async () => assert.deepEqual(await read(), expected));
}

test("each partner stars deals that then lead their column and list", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [width, theme] of [
    [1440, "light"],
    [390, "dark"],
  ] as const) {
    await t.test(`${width} ${theme}`, async (t) => {
      const stars = new Map<string, Set<string>>();
      const fail = { star: false };
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      t.after(() => context.close());
      await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
      const page = await context.newPage();
      const server = await openDeals(page, "joe", stars, fail);
      t.after(() => server.close());
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      await expectOrder(() => boardOrder(page), [alder, birch, cedar]);

      const cedarStar = starButton(page, cedar);
      const box = await cedarStar.boundingBox();
      assert.ok(box && box.width >= 44 && box.height >= 44, "the star is a 44 px target");
      const card = await page.locator(".kanban-card", { has: cedarStar }).boundingBox();
      assert.ok(card && box.x + box.width <= card.x + card.width + 1, "the star stays inside its card");
      const unstarredColor = await cedarStar.evaluate((b) => getComputedStyle(b).color);

      await cedarStar.click();
      await settles(async () => assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "true"));
      await expectOrder(() => boardOrder(page), [cedar, alder, birch]);
      assert.notEqual(await starButton(page, cedar).evaluate((b) => getComputedStyle(b).color), unstarredColor);
      assert.equal(await page.locator(".kanban-card").filter({ hasText: cedar }).count(), 1, "opening stays separate");
      assert.equal(await page.getByRole("dialog").filter({ hasText: cedar }).count(), 0);

      await starButton(page, birch).click();
      await expectOrder(() => boardOrder(page), [birch, cedar, alder]);
      await starButton(page, cedar).click();
      await expectOrder(() => boardOrder(page), [birch, alder, cedar]);
      assert.deepEqual([...(stars.get("joe") ?? [])], [deals[1]?.id]);

      fail.star = true;
      await starButton(page, alder).click();
      await page.getByText("Could not star this deal. Try again.").waitFor();
      assert.equal(await starButton(page, alder).getAttribute("aria-pressed"), "false");
      await expectOrder(() => boardOrder(page), [birch, alder, cedar]);
      fail.star = false;

      await page.locator("#listView").click();
      await expectOrder(() => order(page, ".deal-list .kanban-card"), [birch, alder, cedar]);
      await starButton(page, cedar).click();
      await expectOrder(() => order(page, ".deal-list .kanban-card"), [birch, cedar, alder]);
      const rowStar = await starButton(page, cedar).boundingBox();
      assert.ok(rowStar && rowStar.width >= 44 && rowStar.height >= 44);

      const dellPage = await context.newPage();
      const dellServer = await openDeals(dellPage, "dell", stars, fail);
      t.after(() => dellServer.close());
      await expectOrder(() => boardOrder(dellPage), [alder, birch, cedar]);
      assert.equal(await starButton(dellPage, birch).getAttribute("aria-pressed"), "false");
      await starButton(dellPage, cedar).click();
      await expectOrder(() => boardOrder(dellPage), [cedar, alder, birch]);
      assert.deepEqual([...(stars.get("dell") ?? [])], [deals[2]?.id]);

      await page.reload();
      await page
        .locator("#boardAsOf")
        .filter({ hasText: /^Updated / })
        .waitFor();
      await page.locator("#boardView").click();
      await expectOrder(() => boardOrder(page), [birch, cedar, alder]);
      assert.equal(await starButton(page, alder).getAttribute("aria-pressed"), "false");
    });
  }
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
