import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Page, Route } from "@playwright/test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

const reply = (route: Route, value: unknown) =>
  route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(value) }] } } });

const step = "00000000-0000-0000-0000-000000000010";
const task = {
  item_id: `next_action:${step}`,
  source_type: "next_action",
  source_id: step,
  source_version: "7",
  source_state: "needs_attention",
  base_version: "legacy:7",
  title: "Send the sample floor plan",
  activity_at: "2026-11-02T12:00:00.000Z",
  completed_at: null,
  due_on: "2026-11-03",
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  explicit_unsettle: false,
  auto_settled: false,
  context_label: "Example Dental",
  open_url: "/deals?deal=00000000-0000-0000-0000-000000000001&focus=next-step",
  kind_label: "Task",
  action_id: step,
  action_version: 7,
  deal_id: "00000000-0000-0000-0000-000000000001",
  merged_source_ids: [step],
  waiting_version: 0,
  waiting_on: null,
};
const inbox = {
  ok: true,
  schema_version: "home-inbox.v5",
  truncated: false,
  limit: 1000,
  working_collapsed: true,
  auto_settle_enabled: true,
  items: [task],
};
const empty = { count: 0, items: [] };
const dashboard = {
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: {
    count: 1,
    items: [
      {
        ...task,
        card_id: task.item_id,
        base_version: "7:0:inbox",
        why: "The practice asked for it",
        primary_action: "Mark done",
        source_activity: null,
        undo_completion: false,
        returns_at: null,
        waiting_reason: null,
        days_late: null,
        late_label: null,
      },
    ],
  },
  inbox: empty,
  waiting: empty,
};
const deal = {
  id: "demo-deal",
  name: "Demo Placeholder Practice",
  phase: "Research",
  owner: "joe",
  operating_state: "active",
};
const board = { actor: "joe", workspace_kind: "team", deals: [deal] };
const dealRoom = {
  ...deal,
  deal_id: deal.id,
  thread: [],
  critical_dates: [],
  next_actions: [],
  activities: [],
  events: [],
};

type Screen = {
  name: string;
  path: string;
  held: string;
  answers: Record<string, unknown>;
  shape: string;
  status: string;
  content: (page: Page) => ReturnType<Page["locator"]>;
};
const screens: Screen[] = [
  {
    name: "Home",
    path: "/?mode=live",
    held: "read-home-inbox-v5",
    answers: { "read-home-inbox-v5": inbox },
    shape: ".home-placeholder",
    status: "Loading your inbox…",
    content: (page) => page.getByRole("link", { name: /^Send the sample floor plan/ }),
  },
  {
    name: "Deals board",
    path: "/deals?mode=live",
    held: "deal-room-board",
    answers: { "deal-room-board": board },
    shape: ".board-placeholder-card",
    status: "Updating…",
    content: (page) => page.locator('.kanban-card[data-id="demo-deal"]'),
  },
  {
    name: "Deals list",
    path: "/deals?mode=live&view=list",
    held: "deal-room-board",
    answers: { "deal-room-board": board },
    shape: ".board-placeholder-row",
    status: "Updating…",
    content: (page) => page.locator('.deal-row[data-id="demo-deal"]'),
  },
  {
    name: "Deal page",
    path: "/deals?mode=live&deal=demo-deal",
    held: "get-deal-room",
    answers: { "deal-room-board": board, "get-deal-room": dealRoom },
    shape: ".deal-placeholder .panel-section",
    status: "Updating…",
    content: (page) => page.getByRole("region", { name: "Deal snapshot" }),
  },
];

let outDir: string;
let origin: string;
let browser: Awaited<ReturnType<typeof chromium.launch>>;
let closeServer: () => Promise<unknown>;
before(async () => {
  outDir = await temporaryDirectory("loading-placeholders-");
  await buildArtifact({ root: process.cwd(), outDir });
  const server = await ownedFixtureServer({ root: join(outDir, "site") });
  origin = server.origin;
  closeServer = server.close;
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  await closeServer?.();
  if (outDir) await rm(outDir, { recursive: true, force: true });
});

type Answer = (route: Route, name: string) => Promise<void>;
async function open(
  t: { after: (fn: () => unknown) => void },
  path: string,
  options: Parameters<typeof browser.newPage>[0],
  answer: Answer,
  theme = "light",
  prepare = async (_page: Page) => {},
) {
  const page = await browser.newPage(options);
  await prepare(page);
  t.after(() => page.close());
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
    localStorage.setItem("doctorcre:today:/deals", "closed");
  }, theme);
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-placeholders" } }),
  );
  await page.route("**/mcp", (route) => answer(route, route.request().postDataJSON().params.name));
  await page.goto(`${origin}${path}`);
  return { page, errors };
}

for (const screen of screens)
  for (const width of [1440, 390])
    for (const theme of ["light", "dark"] as const)
      test(`${screen.name} shows grey placeholders during a slow read, then content, at ${width}px ${theme}`, async (t) => {
        // Dark runs with reduced motion so both settings are covered.
        const reducedMotion = theme === "dark" ? "reduce" : "no-preference";
        let release = () => {};
        const held = new Promise<void>((resolve) => {
          release = resolve;
        });
        t.after(release);
        const viewport = { width, height: 900 };
        const { page, errors } = await open(
          t,
          screen.path,
          { viewport, colorScheme: theme, reducedMotion },
          async (route, name) => {
            if (name === screen.held) await held;
            await reply(route, screen.answers[name] ?? { ok: true, items: [], deals: [] });
          },
          theme,
        );

        const shapes = page.locator(screen.shape);
        await shapes.first().waitFor();
        assert.ok((await shapes.count()) >= 2, "Several shapes stand in for the content");
        assert.equal((await page.getByRole("status").filter({ hasText: screen.status }).count()) > 0, true);
        assert.equal(await page.locator("text=/\\b0 open deals/").count(), 0, "No count is claimed before the read");
        const look = await page
          .locator(`${screen.shape} .skeleton-line`)
          .first()
          .evaluate((line) => {
            const style = getComputedStyle(line);
            const box = line.getBoundingClientRect();
            return {
              fill: style.backgroundColor,
              ground: getComputedStyle(document.body).backgroundColor,
              animation: style.animationName,
              width: box.width,
              height: box.height,
            };
          });
        assert.notEqual(look.fill, look.ground, "The grey shape stands out from the page");
        assert.ok(look.width > 20 && look.height > 0, "The shape has a visible size");
        assert.equal(
          look.animation === "none",
          reducedMotion === "reduce",
          "The shapes fade only when motion is allowed",
        );
        assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), "No sideways scroll");

        release();
        await screen.content(page).first().waitFor();
        assert.equal(await shapes.count(), 0, "The placeholders leave once the content arrives");
        assert.deepEqual(errors, []);
      });

test("Engine Home holds a grey tile where Today's meetings will appear while the calendar reads", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  const { page, errors } = await open(
    t,
    "/?mode=live",
    { viewport: { width: 1440, height: 900 }, timezoneId: "America/Chicago" },
    (route, name) => reply(route, name === "read-home-inbox-v5" ? inbox : { ok: true, items: [], deals: [] }),
    "light",
    async (page) => {
      await page.clock.install({ time: new Date("2026-11-03T15:00:00Z") });
      await page.route(/\/\?mode=live$/, async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace("<html ", "<html data-home-today-from-engine ");
        await route.fulfill({ response, body: html });
      });
      await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
        route.fulfill({ json: dashboard }),
      );
      await page.route("**/api/engine/home/today", async (route) => {
        await held;
        await route.fulfill({
          json: {
            ok: true,
            schema_version: "home-today.v1",
            today: "2026-11-03",
            viewer: "joe",
            meetings: {
              state: "ready",
              items: [{ title: "Sample site walk", start: "2026-11-03T18:00:00Z", end: "2026-11-03T19:00:00Z" }],
            },
          },
        });
      });
    },
  );
  await page.getByRole("link", { name: /^Send the sample floor plan/ }).waitFor();
  assert.equal(await page.locator(".home-placeholder").count(), 1);
  release();
  await page.getByRole("region", { name: "Today's meetings" }).waitFor();
  assert.equal(await page.locator(".home-placeholder").count(), 0);
  assert.deepEqual(errors, []);
});

test("A failed first board read leaves the board empty, not grey", async (t) => {
  const { page } = await open(t, "/deals?mode=live", { viewport: { width: 1440, height: 900 } }, (route, name) =>
    name === "deal-room-board"
      ? route.fulfill({ status: 500, json: { error: "synthetic" } })
      : reply(route, { ok: true, items: [], deals: [] }),
  );
  await page.getByText(/The board could not be read/).waitFor();
  assert.equal(await page.locator(".board-placeholder").count(), 0);
  assert.equal(await page.locator("#kanban").getAttribute("aria-busy"), "false");
});

async function heldBoard(t: { after: (fn: () => unknown) => void }, path: string, width: number) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  t.after(release);
  const { page, errors } = await open(t, path, { viewport: { width, height: 900 } }, async (route, name) => {
    if (name === "deal-room-board") await held;
    await reply(route, name === "deal-room-board" ? board : { ok: true, items: [], deals: [] });
  });
  return { page, errors, release };
}

for (const path of ["/deals?mode=live", "/deals?mode=live&view=list"])
  test(`${path} says Updating… once while the first read is held`, async (t) => {
    const { page, errors } = await heldBoard(t, path, 1440);
    await page.locator(".board-placeholder").first().waitFor();
    assert.equal(await page.locator('text="Updating…"').filter({ visible: true }).count(), 1);
    assert.deepEqual(errors, []);
  });

test("The first board column holds still at 390px when the read lands", async (t) => {
  const { page, errors, release } = await heldBoard(t, "/deals?mode=live", 390);
  const top = (selector: string) =>
    page
      .locator(selector)
      .filter({ visible: true })
      .first()
      .evaluate((node) => node.getBoundingClientRect().top + scrollY);
  await page.locator(".board-placeholder").first().waitFor();
  const before = await top("#kanban > .kanban-column");
  release();
  await page.locator('.kanban-card[data-id="demo-deal"]').waitFor();
  assert.equal(await top("#kanban > .kanban-column:not(.board-placeholder)"), before);
  assert.deepEqual(errors, []);
});
