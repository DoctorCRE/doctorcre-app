import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
before(async () => {
  const outDir = temporaryDirectory("home-columns-");
  await buildArtifact({ root: process.cwd(), outDir });
  server = await ownedFixtureServer({ root: join(outDir, "site") });
});
after(() => server?.close());

const today = "2026-11-25";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const card = (n: number, title: string, fields: Record<string, unknown> = {}) => ({
  item_id: `next_action:${id(n)}`,
  card_id: `next_action:${id(n)}`,
  source_type: "next_action",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "The practice asked for it",
  primary_action: "Mark done",
  activity_at: "2026-11-24T15:00:00.000Z",
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Example Dental",
  open_url: `/deals?deal=${id(99)}&focus=next-step&step=${id(n)}`,
  deal_id: id(99),
  kind_label: "Task",
  action_id: id(n),
  action_version: 1,
  merged_source_ids: [id(n)],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "reminders",
  ...fields,
});
const late = (n: number, title: string, days: number) =>
  card(n, title, {
    due_on: new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10),
    days_late: days,
  });
const group = (items: unknown[]) => ({ count: items.length, items });
const dashboard = {
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: group([
    late(1, "Call the sample practice", 3),
    late(2, "Send the sample lease comments", 14),
    late(3, "Follow up on the old sample", 15),
    card(4, "Send the sample floor plan", { due_on: today }),
    card(5, "Ask for the sample estimate"),
  ]),
  inbox: group([
    card(11, "Send your reply to the sample practice", {
      item_id: `suggestion:${id(11)}`,
      card_id: `suggestion:${id(11)}`,
      source_type: "email_proposal",
      action_id: null,
      action_version: null,
      deal_id: null,
      open_url: null,
      kind_label: "Suggestion",
      primary_action: "Review suggestions",
      tile: "inbox",
    }),
  ]),
  waiting: group([
    card(21, "Send the sample parking study", {
      section: "snoozed",
      disposition: "snoozed",
      snoozed_until: "2026-12-01T15:00:00Z",
      returns_at: "2026-12-01T15:00:00Z",
      waiting_reason: "Snoozed",
      primary_action: null,
    }),
  ]),
};

async function openHome(t: TestContext, width: number, height: number) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: "America/Chicago" });
  await page.clock.setFixedTime(new Date("2026-11-25T16:00:00Z"));
  await page.addInitScript(() =>
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ walkthroughSeen: { joe: true } })),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route(
    (url) => url.pathname === "/" && url.searchParams.get("mode") === "live",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html ", "<html data-home-today-from-engine ");
      await route.fulfill({ response, body });
    },
  );
  await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
    route.fulfill({ json: dashboard }),
  );
  await page.route("**/api/engine/home/today", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-today.v1",
        today,
        viewer: null,
        meetings: {
          state: "ready",
          items: [{ title: "Sample site visit", start: "2026-11-25T20:00:00Z", end: "2026-11-25T21:00:00Z" }],
        },
      },
    }),
  );
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole("region", { name: "Reminders", exact: true }).waitFor();
  return page;
}

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`Home shows Reminders, Inbox and the day side by side on one ${width}x${height} screen`, async (t) => {
    const page = await openHome(t, width, height);
    const reminders = page.getByRole("region", { name: "Reminders", exact: true });
    const inbox = page.getByRole("region", { name: "Inbox", exact: true });
    const waiting = page.getByRole("region", { name: "In motion and waiting", exact: true });
    const meetings = page.getByRole("region", { name: "Today's meetings", exact: true });
    await meetings.waitFor();
    assert.equal(await reminders.getByRole("heading", { level: 2 }).textContent(), "Reminders 5 · 2 late");
    const groups = await reminders.getByRole("region").evaluateAll((nodes) => nodes.map((node) => node.ariaLabel));
    assert.deepEqual(groups, ["Late", "Today", "No date"]);
    assert.deepEqual(await inbox.getByRole("button").allTextContents(), ["Review"]);
    assert.deepEqual(await waiting.getByRole("button").allTextContents(), ["Wake"]);
    assert.equal(await page.getByRole("checkbox").count(), 0);
    assert.equal(await page.getByRole("button", { name: "Snooze selected" }).count(), 0);
    const box = async (tile: typeof inbox) => (await tile.boundingBox()) ?? assert.fail("tile is not drawn");
    const [left, middle, below, right] = [
      await box(reminders),
      await box(inbox),
      await box(waiting),
      await box(meetings),
    ];
    assert.ok(left.x + left.width <= middle.x && middle.x + middle.width <= right.x, "three columns, left to right");
    assert.ok(Math.abs(below.x - middle.x) < 1 && below.y >= middle.y + middle.height, "waiting sits under Inbox");
    assert.equal(
      await page.evaluate(() => document.scrollingElement?.scrollHeight),
      height,
      "the page does not scroll",
    );
  });

test("Reminders 15 or more days late fold into one line that opens in place", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const lateRows = reminders.getByRole("region", { name: "Late" }).getByRole("article");
  assert.deepEqual(await lateRows.getByRole("link").allTextContents(), [
    "Send the sample lease comments",
    "Call the sample practice",
  ]);
  assert.equal(await reminders.getByText("Follow up on the old sample").count(), 0);
  await reminders.getByRole("button", { name: "1 more than two weeks late" }).click();
  await reminders
    .getByRole("region", { name: "More than two weeks late" })
    .getByText("Follow up on the old sample")
    .waitFor();
  assert.equal(await reminders.getByRole("heading", { level: 2 }).textContent(), "Reminders 5 · 2 late");
});

test("On a phone Today's meetings comes first and In motion and waiting last", async (t) => {
  const page = await openHome(t, 390, 844);
  await page.getByRole("region", { name: "Today's meetings", exact: true }).waitFor();
  const tiles = await page.locator(".home-slice").evaluateAll((nodes) =>
    nodes
      .map((node) => ({ name: node.getAttribute("aria-label"), top: node.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map(({ name }) => name),
  );
  assert.deepEqual(tiles, ["Today's meetings", "Reminders", "Inbox", "In motion and waiting"]);
});
