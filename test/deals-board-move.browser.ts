import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const dealId = "00000000-0000-4000-8000-00000000d170";
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };

async function openBoard(t: TestContext) {
  const writes: unknown[] = [];
  const deal = () => ({
    id: dealId,
    name: "Example Aspen Dental Relocation",
    owner: "dell",
    phase: "negotiation",
    operating_state: "active",
    seen: 7 + writes.length,
    open_actions: [],
  });
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === `/api/engine/deals/${dealId}/changes`) {
          const { idempotency_key: _key, ...body } = await request.json();
          writes.push(body);
          return Response.json({ deal_id: dealId, change_id: 8 + writes.length });
        }
        if (path === "/api/engine/deals")
          return Response.json({
            schema_version: "local-deals-board.v2",
            actor: "joe",
            deals: [deal()],
            closed_deals: [],
            lost_deals: [],
            accounts: [],
          });
        if (path.endsWith("/prospects")) return Response.json({ count: 0, prospects: [] });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
  const server = await startWorkerFixture({ assets: await appAssetSnapshot(), env });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
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
  const card = page.locator(`.kanban-card[data-id="${dealId}"]`);
  await card.waitFor();
  const question = page.getByRole("dialog", { name: "Move this deal to Legal?" });
  return { page, card, question, writes };
}

test("dragging a card asks one short question and moves only on Move to the phase", async (t) => {
  const { page, card, question, writes } = await openBoard(t);
  const legal = page.locator('.kanban-column[data-column="legal"]');
  await card.dragTo(legal);
  await question.waitFor();
  assert.equal(await question.getByText("Example Aspen Dental Relocation").isVisible(), true, "it names the deal");
  assert.deepEqual(
    await question
      .locator("input:visible, textarea:visible, select:visible")
      .evaluateAll((fields) => fields.map((field) => field.getAttribute("aria-label"))),
    ["What changed (optional)"],
    "the only question is an optional note",
  );
  await question.getByRole("button", { name: "Cancel", exact: true }).click();
  assert.deepEqual(writes, [], "Cancel saves nothing");
  assert.equal(await page.locator('.kanban-column[data-column="negotiation"]').locator(card).count(), 1);

  await card.dragTo(legal);
  await question.getByLabel("What changed (optional)").fill("Example terms agreed");
  await question.getByRole("button", { name: "Move to Legal" }).click();
  await question.waitFor({ state: "hidden" });
  assert.deepEqual(writes, [
    { seen_change_id: 7, phase: { from: "negotiation", to: "legal", reason: "Example terms agreed" } },
  ]);
});

test("the keyboard move asks the same question", async (t) => {
  const { page, card, question, writes } = await openBoard(t);
  await card.focus();
  await page.keyboard.press("Enter");
  await page.keyboard.press("ArrowRight");
  await page.keyboard.press("Enter");
  await question.waitFor();
  await page.keyboard.press("Enter");
  await question.waitFor({ state: "hidden" });
  assert.deepEqual(writes, [{ seen_change_id: 7, phase: { from: "negotiation", to: "legal" } }]);
});
