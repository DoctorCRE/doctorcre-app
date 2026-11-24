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

type Fixture = { star: boolean; boardRead?: Promise<void>; withoutStarred?: boolean };

async function openDeals(page: Page, actor: string, stars: Map<string, Set<string>>, fail: Fixture) {
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
        await fail.boardRead;
        return Response.json({
          schema_version: "local-deals-board.v2",
          actor,
          deals: fail.withoutStarred ? deals : deals.map((d) => ({ ...d, starred: mine.has(d.id) })),
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

test("a keyboard partner can star and unstar without lifting the card", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const fixture: Fixture = { star: false };
  const server = await openDeals(page, "joe", new Map(), fixture);
  t.after(() => server.close());

  await page.locator(".kanban-card", { has: starButton(page, cedar) }).focus();
  for (let tab = 0; tab < 5; tab++) {
    if (await starButton(page, cedar).evaluate((b) => b === document.activeElement)) break;
    await page.keyboard.press("Tab");
  }
  assert.ok(await starButton(page, cedar).evaluate((b) => b === document.activeElement), "Tab reaches the star");

  let release = () => {};
  fixture.boardRead = new Promise((resolve) => {
    release = resolve;
  });
  await page.keyboard.press("Space");
  await settles(async () => assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "true"));
  await starButton(page, cedar).evaluate((b) => b.setAttribute("data-before-refresh", ""));
  release();
  await settles(async () =>
    assert.equal(await page.locator("[data-before-refresh]").count(), 0, "the refresh repainted"),
  );
  await expectOrder(() => boardOrder(page), [cedar, alder, birch]);
  assert.ok(await starButton(page, cedar).evaluate((b) => b === document.activeElement), "focus stays on the star");

  await page.keyboard.press("Space");
  await settles(async () => assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "false"));
  assert.doesNotMatch((await page.locator("#dragLive").textContent()) ?? "", /lifted/);
  assert.equal(await page.locator('[data-lifted="true"]').count(), 0);
});

test("an older board read without stars shows no stars and the usual order", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors: Error[] = [];
  page.on("pageerror", (error) => errors.push(error));
  const server = await openDeals(page, "joe", new Map(), { star: false, withoutStarred: true });
  t.after(() => server.close());
  await expectOrder(() => boardOrder(page), [alder, birch, cedar]);
  assert.equal(await page.locator("[data-star]").count(), 0);
  await page.locator("#listView").click();
  await expectOrder(() => order(page, ".deal-list .kanban-card"), [alder, birch, cedar]);
  assert.equal(await page.locator("[data-star]").count(), 0);
  assert.deepEqual(errors, []);
});

test("the card quick menu stars and unstars like the star button", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const stars = new Map<string, Set<string>>();
  const fixture: Fixture = { star: false };
  const server = await openDeals(page, "joe", stars, fixture);
  t.after(() => server.close());

  const menuItems = async (cards: string, name: string) => {
    await page.locator(cards, { has: starButton(page, name) }).focus();
    await page.keyboard.press("Shift+F10");
    const menu = page.getByRole("menu", { name: `Actions for ${name}` });
    await menu.waitFor();
    return { menu, labels: await menu.getByRole("menuitem").allInnerTexts() };
  };
  const tile = '.kanban-column[data-column="pending"] .kanban-card';

  let { menu, labels } = await menuItems(tile, cedar);
  assert.deepEqual(labels, ["Open", "Star"]);
  await menu.getByRole("menuitem", { name: "Star", exact: true }).click();
  await settles(async () => assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "true"));
  await expectOrder(() => boardOrder(page), [cedar, alder, birch]);
  assert.deepEqual([...(stars.get("joe") ?? [])], [deals[2]?.id]);

  ({ menu, labels } = await menuItems(tile, cedar));
  assert.deepEqual(labels, ["Open", "Unstar"]);
  fixture.star = true;
  await menu.getByRole("menuitem", { name: "Unstar", exact: true }).click();
  await page.getByText("Could not unstar this deal. Try again.").waitFor();
  assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "true", "a failed save keeps the star");
  fixture.star = false;

  await page.locator("#listView").click();
  await expectOrder(() => order(page, ".deal-list .kanban-card"), [cedar, alder, birch]);
  ({ menu, labels } = await menuItems(".deal-list .kanban-card", cedar));
  assert.equal(labels.filter((label) => label === "Unstar").length, 1);
  assert.equal(labels.filter((label) => label === "Star").length, 0);
  await menu.getByRole("menuitem", { name: "Unstar", exact: true }).click();
  await settles(async () => assert.equal(await starButton(page, cedar).getAttribute("aria-pressed"), "false"));
  await expectOrder(() => order(page, ".deal-list .kanban-card"), [alder, birch, cedar]);
  assert.deepEqual([...(stars.get("joe") ?? [])], []);

  ({ labels } = await menuItems(".deal-list .kanban-card", alder));
  assert.equal(labels.filter((label) => label === "Star").length, 1);
  await page.keyboard.press("Escape");
});

test("list row stars sit level with the row text at 1440 px", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const server = await openDeals(page, "joe", new Map(), { star: false });
  t.after(() => server.close());
  await page.locator("#listView").click();
  const row = page.locator(".deal-list .kanban-card", { has: starButton(page, alder) });
  const centers = await row.evaluate((card) =>
    [".deal-star svg", ".owner", ".card-open"].map((selector) => {
      const box = card.querySelector(selector)?.getBoundingClientRect();
      return box ? box.top + box.height / 2 : Number.NaN;
    }),
  );
  const [star, ...text] = centers;
  for (const line of text) assert.ok(Math.abs((star ?? 0) - (line ?? 0)) <= 1, `star ${star} vs text ${line}`);
});
