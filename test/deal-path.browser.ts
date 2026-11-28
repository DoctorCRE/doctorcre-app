import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const shots = "out/test-artifacts/deal-path";
await mkdir(shots, { recursive: true });
const dealId = "00000000-0000-4000-8000-00000000d160";
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };
const todo = (id: string, label: string, status: string, due_on: string | null = null) => ({
  id,
  label,
  status,
  due_on,
  evidence_ref: status === "complete" ? `${label} filed` : null,
  source: { document: "deal-room-kit" },
});
const checklist = {
  schema_version: "deal-checklist.v1",
  template_state: "current",
  due_items: [],
  phases: [
    { id: "research", label: "Research", items: [todo("representation", "Representation agreement", "complete")] },
    { id: "site_selection", label: "Site selection", items: [todo("market_survey", "Market survey", "complete")] },
    {
      id: "negotiation",
      label: "Negotiation / LOI",
      items: [
        todo("loi_submission", "LOIs sent", "complete"),
        todo("loi_grid", "Terms comparison", "overdue", "2026-11-24"),
        todo("business_terms", "Agreed business terms", "not_recorded"),
      ],
    },
    {
      id: "legal",
      label: "Legal / lease",
      items: [
        todo("contract_draft", "Lease draft to attorney", "not_recorded"),
        todo("critical-date:00000000-0000-4000-8000-00000000da11", "Example deadline", "upcoming", "2026-12-09"),
      ],
    },
    { id: "closing", label: "Closing", items: [todo("executed_lease", "Executed lease", "not_recorded")] },
    { id: "invoice", label: "Invoice", items: [todo("invoice_recorded", "Invoice", "not_recorded")] },
  ],
};

async function openDeal(
  t: TestContext,
  viewport: { width: number; height: number },
  {
    theme = "dark",
    parked = false,
    checklistOverride,
    omitFollowUps = false,
    delayMove = false,
  }: {
    theme?: "dark" | "light";
    parked?: boolean;
    checklistOverride?: unknown;
    omitFollowUps?: boolean;
    delayMove?: boolean;
  } = {},
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { CARR: { fetch: async () => Response.json(session) }, ENGINE_ROUTING: { get: async () => "on" } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport, colorScheme: theme });
  await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-11-25T17:00:00Z"));
  const writes: unknown[] = [];
  let releaseMove: (() => void) | null = null;
  const moveGate = delayMove
    ? new Promise<void>((resolve) => {
        releaseMove = resolve;
      })
    : null;
  const deal = () => ({
    id: dealId,
    deal_id: dealId,
    name: "Example Birch Dental Expansion",
    client_name: "Example Birch Dental",
    client_id: "00000000-0000-4000-8000-00000000c160",
    phase: "negotiation",
    owner: "dell",
    seen: 7 + writes.length,
    kind: "lease",
    reason: "expansion",
    market: "Example City",
    next_deal_saves: true,
    next_actions: [],
    critical_dates: [],
    vendors: [],
    ...(omitFollowUps ? {} : { email_follow_ups: [] }),
    correspondence: [],
    documents: [],
    checklist: checklistOverride === undefined ? checklist : checklistOverride,
    phase_change: {
      source: "copied",
      automatic: true,
      event_id: "00000000-0000-4000-8000-00000000e160",
      evidence_date: "2026-11-23",
      undoable: true,
      prior_phase: "site_selection",
      phase: "negotiation",
    },
    ...(parked && {
      operating_state: "parked",
      parking_reason: "client_paused",
      parking_note: "Waiting on the partner's buy-in",
      parked_at: "2026-11-02T15:00:00Z",
    }),
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
          if (moveGate) await moveGate;
          writes.push(body);
          return Response.json({
            deal_id: dealId,
            change_id: 8 + writes.length,
            phase_changed_at: "2026-11-25T17:00:00Z",
          });
        }
        if (path === `/api/engine/deals/${dealId}`) return Response.json(deal());
        if (path === "/api/engine/deals")
          return Response.json({ schema_version: "local-deals-board.v2", actor: "joe", deals: [deal()] });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
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
  await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
  await page.locator(".deal-path").waitFor();
  await page.waitForLoadState("networkidle");
  return { page, writes, path: page.getByRole("region", { name: "Deal path" }), releaseMove: () => releaseMove?.() };
}

test("the desktop path keeps the three nearby phases visible and opens the others by count", async (t) => {
  const { page, path } = await openDeal(t, { width: 1440, height: 772 });
  assert.equal(await page.locator("#detailPhase").count(), 0, "the phase dropdown is gone");
  const tiles = path.locator(".deal-path-tile");
  assert.deepEqual(await tiles.locator(".deal-path-name").allTextContents(), [
    "Prospective Client",
    "Research",
    "Site Selection",
    "Negotiating",
    "Legal",
    "Due Diligence",
    "Closing",
    "Closed",
  ]);
  assert.deepEqual(await tiles.locator(".deal-path-name:visible").allTextContents(), [
    "Site Selection",
    "Negotiating",
    "Legal",
  ]);
  const pathRow = path.locator(".deal-path");
  const height = (await pathRow.boundingBox())?.height;
  await path.getByText("2 earlier phases").click();
  assert.equal(await path.getByText("Prospective Client", { exact: true }).isVisible(), true);
  assert.equal((await pathRow.boundingBox())?.height, height);
  await path.getByText("2 earlier phases").click();
  await path.getByText("3 later phases").click();
  assert.equal(await path.getByText("Closed", { exact: true }).isVisible(), true);
  await path.getByText("3 later phases").click();
  const current = path.locator('[aria-current="step"]');
  assert.equal(await current.locator(".deal-path-head").textContent(), "Negotiating1 of 3");
  assert.equal(
    await current.getByRole("button", { name: "Negotiating" }).count(),
    0,
    "the current phase is not a move",
  );
  assert.equal(await path.locator('[data-place="done"] .deal-path-check').count(), 3, "earlier phases are checked");
  assert.equal(await path.locator('[data-phase="pending"] .deal-path-empty').textContent(), "Nothing listed");
  assert.equal(await path.locator('[data-phase="due_diligence"] .deal-path-empty').textContent(), "Nothing listed");
  assert.equal(await path.locator('[data-todo="loi_grid"] small').textContent(), "Was due Nov 24");
  assert.equal(
    await path.locator('[data-phase="legal"] [data-todo]').count(),
    1,
    "a critical date shows only in its own row",
  );
  assert.equal(await path.locator('[data-phase="closed"] [data-todo="invoice_recorded"]').count(), 1);
  assert.match((await page.locator("#workspacePhaseMove").textContent()) ?? "", /Moved automatically.*Nov 23.*Undo/);
  assert.equal(await current.getByText(/Moved automatically/).count(), 0);
  await path.getByText("Market survey", { exact: true }).click();
  assert.equal(await path.getByText("Market survey filed").isVisible(), true, "a to-do opens to what is filed");
});

test("a phase click asks first and moves with only an optional note", async (t) => {
  const { page, writes, path } = await openDeal(t, { width: 1440, height: 772 });
  await path.getByRole("button", { name: "Legal", exact: true }).click();
  const ask = path.getByRole("form", { name: "Move this deal to Legal?" });
  await ask.getByRole("button", { name: "Cancel" }).click();
  assert.equal(await ask.count(), 0);
  assert.deepEqual(writes, [], "Cancel saves nothing");
  await path.getByRole("button", { name: "Legal", exact: true }).click();
  await ask.getByLabel("What changed (optional)").fill("Example terms agreed");
  await page.screenshot({ path: `${shots}/ask-1440.png` });
  await ask.getByRole("button", { name: "Move to Legal" }).click();
  await page.waitForFunction(() => !document.querySelector(".deal-path-ask"));
  assert.deepEqual(writes, [
    { seen_change_id: 7, phase: { from: "negotiation", to: "legal", reason: "Example terms agreed" } },
  ]);
});

test("Closed asks Won or Lost with compact chips and hides Closed value until Won is picked", async (t) => {
  const { writes, path } = await openDeal(t, { width: 1440, height: 772 });
  await path.getByText("3 later phases").click();
  await path.getByRole("button", { name: "Closed", exact: true }).click();
  const ask = path.getByRole("form", { name: "Close this deal" });
  assert.equal(await ask.getByLabel("Closed on").inputValue(), "2026-11-25");
  assert.equal(
    await ask.getByLabel("Closed value (optional)").isVisible(),
    false,
    "Closed value stays hidden before Won",
  );
  assert.equal(
    await ask.getByLabel("Reason the deal was lost").isVisible(),
    false,
    "Lost reason stays hidden before Lost",
  );
  const chips = await ask.locator(".deal-path-outcome .chip").evaluateAll((nodes) =>
    nodes.map((node) => {
      const box = node.getBoundingClientRect();
      const radio = node.querySelector("input")?.getBoundingClientRect();
      const label = node.querySelector("span")?.getBoundingClientRect();
      return {
        direction: getComputedStyle(node).flexDirection,
        width: box.width,
        height: box.height,
        radioWidth: radio?.width ?? 0,
        radioHeight: radio?.height ?? 0,
        inline: Boolean(radio && label && radio.right <= label.left + 1),
      };
    }),
  );
  assert.equal(chips.length, 2);
  for (const chip of chips) {
    assert.equal(chip.direction, "row");
    assert.ok(chip.radioWidth <= 20 && chip.radioHeight <= 20, `compact radio ${JSON.stringify(chip)}`);
    assert.ok(chip.width > chip.height, `horizontal chip ${JSON.stringify(chip)}`);
    assert.equal(chip.inline, true, `radio sits beside label ${JSON.stringify(chip)}`);
  }
  await ask.getByRole("button", { name: "Close deal" }).click();
  assert.equal(await ask.getByRole("status").textContent(), "Choose Won or Lost.");
  await ask.getByText("Won", { exact: true }).click();
  assert.equal(await ask.getByLabel("Closed value (optional)").isVisible(), true, "Won reveals Closed value");
  await ask.getByText("Lost", { exact: true }).click();
  assert.equal(await ask.getByLabel("Closed value (optional)").isVisible(), false);
  await ask.getByRole("button", { name: "Close deal" }).click();
  assert.equal(await ask.getByRole("status").textContent(), "Enter the reason the deal was lost.");
  await ask.getByLabel("Reason the deal was lost").fill("Example client chose another site");
  await ask.getByRole("button", { name: "Close deal" }).click();
  await path.page().waitForFunction(() => !document.querySelector(".deal-path-ask"));
  assert.deepEqual(writes, [
    {
      seen_change_id: 7,
      phase: { from: "negotiation", to: "dead", on: "2026-11-25", reason: "Example client chose another site" },
    },
  ]);
});

test("phase popover closes on second click, outside click and Escape, and ignores stale slow responses", async (t) => {
  const { page, path } = await openDeal(t, { width: 1440, height: 772 });
  const legal = path.getByRole("button", { name: "Legal", exact: true });
  const ask = path.getByRole("form", { name: "Move this deal to Legal?" });

  await legal.click();
  await ask.waitFor();
  await legal.click();
  assert.equal(await ask.count(), 0, "second click on the same phase closes the popover");
  assert.equal(await legal.getAttribute("aria-expanded"), "false");
  assert.equal(await legal.evaluate((node) => node === document.activeElement), true, "second click returns focus");

  await legal.click();
  await ask.waitFor();
  await page.locator("#panelTitle").click();
  assert.equal(await ask.count(), 0, "clicking outside closes the popover");
  assert.equal(await legal.evaluate((node) => node === document.activeElement), true, "outside click returns focus");

  await legal.click();
  await ask.waitFor();
  await legal.focus();
  await page.keyboard.press("Escape");
  assert.equal(await ask.count(), 0, "Escape from the phase button closes the popover");
  assert.equal(await legal.evaluate((node) => node === document.activeElement), true, "Escape returns focus");

  const slow = await openDeal(t, { width: 1440, height: 772 }, { delayMove: true });
  await slow.path.getByRole("button", { name: "Legal", exact: true }).click();
  await slow.path.getByRole("button", { name: "Move to Legal" }).click();
  await slow.path.getByText("3 later phases").click();
  await slow.path.getByRole("button", { name: "Closing", exact: true }).click();
  const closingAsk = slow.path.getByRole("form", { name: "Move this deal to Closing?" });
  await closingAsk.waitFor();
  slow.releaseMove();
  await slow.page.waitForFunction(() => !document.querySelector('[data-path-move="legal"]'));
  assert.equal(await closingAsk.count(), 1, "a stale response cannot close a newly opened popover");
});

test("unavailable checklist says so instead of Nothing listed, and deals without email_follow_ups still use the path", async (t) => {
  for (const template_state of ["unavailable", "source_changed"]) {
    const { path } = await openDeal(
      t,
      { width: 1440, height: 772 },
      { checklistOverride: { schema_version: "deal-checklist.v1", template_state, phases: [] } },
    );
    assert.match((await path.textContent()) ?? "", /Checklist is unavailable/);
    assert.equal(await path.locator(".deal-path-empty").count(), 0, `${template_state} never shows Nothing listed`);
  }
  const { page, path } = await openDeal(t, { width: 1440, height: 772 }, { omitFollowUps: true });
  assert.equal(await page.locator("#detailPhase").count(), 0);
  assert.equal(await path.locator(".deal-path-tile").count(), 8);
});

test("Park is a quiet line at the bottom and a parked deal shows Revive at the top", async (t) => {
  const open = await openDeal(t, { width: 1440, height: 772 });
  const overview = open.page.locator("#workspace-overview");
  const park = overview.locator(".deal-park-line");
  assert.equal(await park.locator("summary").textContent(), "Park deal");
  const last = await overview.evaluate(
    (section) => section.lastElementChild?.lastElementChild?.lastElementChild?.className,
  );
  assert.equal(last, "deal-park-line", "Park ends the last column of Overview");
  const parked = await openDeal(t, { width: 1440, height: 772 }, { parked: true });
  const line = parked.page.locator(".deal-parked-line");
  assert.match((await line.textContent()) ?? "", /Client paused.*Waiting on the partner's buy-in.*Parked on/);
  assert.equal(await line.getByRole("button", { name: "Revive" }).count(), 1);
  assert.equal(await parked.page.locator(".deal-park-line summary").count(), 0);
  assert.equal(await parked.path.locator("button[data-path-phase]").count(), 0, "a parked deal is revived, not moved");
});

for (const viewport of [
  { width: 1440, height: 772 },
  { width: 1280, height: 640 },
  { width: 500, height: 900 },
])
  for (const theme of ["light", "dark"] as const)
    test(`the path fits at ${viewport.width} in ${theme}`, async (t) => {
      const { page, path } = await openDeal(t, viewport, { theme });
      const box = await path.locator(".deal-path").boundingBox();
      assert.ok(box && box.x + box.width <= viewport.width, "the path stays on the page");
      const current = await path.locator('[aria-current="step"]').boundingBox();
      assert.ok(
        current && current.x >= 0 && current.x + current.width <= viewport.width,
        "the current phase is in view",
      );
      if (viewport.width === 500) {
        for (const phase of ["Due Diligence", "Closing", "Closed"]) {
          const button = path.getByRole("button", { name: phase, exact: true });
          await button.scrollIntoViewIfNeeded();
          await button.click();
          const sheet = await path.locator(".deal-path-ask").boundingBox();
          assert.ok(
            sheet && sheet.x <= 1 && sheet.width >= viewport.width - 2,
            `${phase} sheet spans full 500px width (${JSON.stringify(sheet)})`,
          );
          if (phase !== "Closed") await button.click();
        }
      }
      await path.scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${shots}/path-${viewport.width}-${theme}.png` });
    });
