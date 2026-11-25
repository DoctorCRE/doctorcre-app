import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const shots = "out/test-artifacts/page-panels";
const today = {
  ok: true,
  schema_version: "home-today.v1",
  viewer: "joe",
  partners: [
    { slug: "joe", name: "Joe" },
    { slug: "dell", name: "Dell" },
  ],
  today: "2026-11-19",
  meetings: { state: "ready", observed_at: "2026-11-19T15:00:00Z", items: [], follow_up_reviews: [] },
  reminders: {
    state: "ready",
    late: [],
    upcoming: [{ kind: "step", owner: "joe", title: "Send the sample floor plan", due_on: "2026-11-19" }],
  },
};
const board = {
  schema_version: "local-deals-board.v2",
  actor: "joe",
  deals: [
    {
      id: "00000000-0000-4000-8000-000000000001",
      name: "Example Dental Expansion",
      owner: "dell",
      phase: "research",
      operating_state: "active",
      open_actions: [],
    },
  ],
  closed_deals: [],
  lost_deals: [],
  accounts: [],
};
const prospects = {
  count: 1,
  prospects: [
    {
      party_id: "00000000-0000-4000-8000-000000000002",
      name: "Example Prospect Clinic",
      how_found: "referral",
      owner: null,
      needs_attention: false,
      follow_ups: [],
      change_id: 1,
      latest_note: null,
    },
  ],
};

// A browser already bound to this session keeps its saved panel choices instead of clearing them on first sign-in.
const binding = createHash("sha256")
  .update(JSON.stringify(["joe", "synthetic"]))
  .digest("hex");
let assets: ReturnType<typeof appAssetSnapshot> | undefined;

async function open(t: TestContext, path: string, width: number, saved: Record<string, string> = {}) {
  assets ??= appAssetSnapshot();
  const server = await startWorkerFixture({
    assets: await assets,
    env: {
      PARTNER_SIGN_IN: "engine",
      ENGINE_ROUTING: { get: async () => "on" },
      PARTNER_APP: {
        async fetch(request: Request) {
          const route = new URL(request.url).pathname;
          if (route === "/auth/session") return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic" });
          if (route === "/api/engine/home/today") return Response.json(today);
          if (route === "/api/engine/doc/conversations") return Response.json({ conversations: [], next_before: null });
          if (route.endsWith("/prospects")) return Response.json(prospects);
          return Response.json(board);
        },
      },
    },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width, height: 800 } });
  t.after(() => context.close());
  await context.addInitScript(
    (saved) => {
      for (const [key, value] of Object.entries(saved)) localStorage.setItem(key, value);
    },
    { "doctorcre-session-binding-v1": binding, ...saved },
  );
  const page = await context.newPage();
  await page.goto(`${server.origin}${path}${path.includes("?") ? "&" : "?"}mode=live`);
  await page.locator("#appLayout").waitFor();
  return { page };
}

const todayState = (page: Page) => page.locator("#appLayout").getAttribute("data-today");
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const pagesWithToday = ["/leads", "/doc-chats", "/status", "/deals", "/deals?view=national"];

for (const width of [1280, 1440]) {
  test(`Today starts closed on every page and remembers each page's choice at ${width}px`, async (t) => {
    for (const path of pagesWithToday) {
      const { page } = await open(t, path, width);
      assert.equal(await todayState(page), "closed", `Today starts closed on ${path}`);
      assert.equal(await noSidewaysScroll(page), true, `${path} does not scroll sideways`);
    }
    const leads = await open(t, "/leads", width, { "doctorcre:today:/leads": "open" });
    assert.equal(await todayState(leads.page), "open", "Leads remembers its own open Today");
    await leads.page.getByRole("button", { name: "Today sidebar", exact: true }).click();
    assert.equal(await leads.page.evaluate(() => localStorage.getItem("doctorcre:today:/leads")), "closed");
    const status = await open(t, "/status", width, { "doctorcre:today:/leads": "open" });
    assert.equal(await todayState(status.page), "closed", "another page keeps its own choice");
  });

  test(`Today's partner filters sit on one row at ${width}px`, async (t) => {
    const { page } = await open(t, "/leads", width, { "doctorcre:today:/leads": "open" });
    const owners = page.getByRole("group", { name: "Reminders for" });
    await owners.getByRole("button", { name: "Dell" }).waitFor();
    // A computer with a mouse shows a classic scrollbar, which takes about 15px of a long Today panel.
    await page.locator("#appToday").evaluate((rail) => {
      rail.style.paddingRight = "15px";
    });
    const tops = await owners
      .getByRole("button")
      .evaluateAll((buttons) => buttons.map((button) => Math.round(button.getBoundingClientRect().top)));
    assert.equal(tops.length, 3);
    assert.equal(new Set(tops).size, 1, "Both partners, Joe and Dell share one row");
    await mkdir(shots, { recursive: true });
    await page.locator("#appToday").screenshot({ path: `${shots}/today-${width}.png` });
  });

  test(`Deals names itself once and lists prospects under one Add prospect control at ${width}px`, async (t) => {
    const { page } = await open(t, "/deals", width);
    const lane = page.locator("#prospectsLane");
    await lane.getByRole("button", { name: "Example Prospect Clinic" }).waitFor();
    const titles = await page
      .getByText("Local Deals", { exact: true })
      .filter({ visible: true })
      .evaluateAll((nodes) => nodes.filter((node) => node.getBoundingClientRect().height > 1).length);
    assert.equal(titles, 1, "Local Deals shows once");
    const topBar = page.getByRole("region", { name: "App controls" });
    assert.equal(await topBar.getByRole("link", { name: "National Accounts" }).isVisible(), true);
    assert.equal(await lane.getByRole("textbox", { name: "Prospect name" }).count(), 0, "no open add form");
    const add = lane.getByRole("button", { name: "Add prospect", exact: true });
    assert.equal(await add.count(), 1);
    await add.click();
    const name = lane.getByRole("textbox", { name: "Prospect name" });
    assert.equal(await name.evaluate((input) => input === document.activeElement), true, "quick add takes focus");
    await name.fill("Example New Prospect");
    await lane.getByRole("button", { name: "Person", exact: true }).waitFor();
    await lane.getByLabel("How found").waitFor();
    assert.equal(await lane.getByRole("button", { name: "Add prospect", exact: true }).count(), 1);
    assert.equal(await noSidewaysScroll(page), true);
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/deals-${width}.png` });
  });

  test(`Ask Doc's question box and Recent chats share one left edge at ${width}px`, async (t) => {
    const { page } = await open(t, "/doc-chats", width, { "doctorcre:today:/doc-chats": "open" });
    const question = page.getByLabel("Question for Doc");
    await question.waitFor();
    const recent = page.getByRole("heading", { name: "Recent chats" });
    const [box, list] = await Promise.all([question.boundingBox(), recent.boundingBox()]);
    assert.ok(box && list);
    assert.ok(Math.abs(box.x - list.x) <= 1, `question box starts at ${box.x}, Recent chats at ${list.x}`);
    await mkdir(shots, { recursive: true });
    await page.screenshot({ path: `${shots}/ask-doc-${width}.png` });
  });
}
