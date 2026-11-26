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
const reply = (n: number, title: string) =>
  card(n, title, {
    item_id: `suggestion:${id(n)}`,
    card_id: `suggestion:${id(n)}`,
    source_type: "email_proposal",
    action_id: null,
    action_version: null,
    deal_id: null,
    open_url: null,
    kind_label: "Suggestion",
    primary_action: "Review suggestions",
    tile: "inbox",
  });
const group = (items: unknown[]) => ({ count: items.length, items });
const longInstruction =
  "Ask the sample contractor for an estimate on the second-floor buildout and the new parking lot lighting before Friday";
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
    card(5, "Ask the sample contractor for an estimate on the second-floor buildout and the new parking…", {
      why: longInstruction,
    }),
  ]),
  inbox: group([reply(11, "Send your reply to the sample practice")]),
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

const lead = (n: number, fields: Record<string, unknown> = {}) => ({
  id: `lead-${n}`,
  stage: "new",
  suppressed: false,
  doctor_name: `Sample Lead ${n}`,
  possible_clients: [],
  ...fields,
});
const leads = [lead(1, { new_from_email: true }), lead(2), lead(3, { new_from_email: true }), lead(4)];

const deal = (n: number, phase: string, fields: Record<string, unknown> = {}) => ({
  id: id(100 + n),
  name: `Example Deal ${n}`,
  phase,
  owner: "joe",
  attention: false,
  operating_state: "active",
  workspace_kind: "team",
  next_step_required: false,
  open_actions: [{ id: id(200 + n), owner: "joe", due_on: "2026-12-04", description: "Call the landlord" }],
  ...fields,
});
const deals = [
  deal(1, "Research", { open_actions: [{ id: id(201), owner: "joe", due_on: "2026-11-22", description: "Call" }] }),
  deal(2, "Legal", { attention: true, next_step_required: true, open_actions: [] }),
  deal(3, "Legal"),
  deal(4, "Research", { operating_state: "parked", attention: true }),
  deal(5, "Research", { workspace_kind: "national_account" }),
];
const reviewDeal = (state: string, workspace_kind: string, operating_state: string) => ({
  deal_id: id(500),
  state,
  workspace_kind,
  operating_state,
  reviewed: null,
});
const reviewItems = [
  { ...reviewDeal("open", "team", "active"), reviewed: { by: "joe" } },
  reviewDeal("open", "team", "active"),
  reviewDeal("open", "team", "active"),
  reviewDeal("open", "team", "parked"),
  reviewDeal("open", "national_account", "active"),
  reviewDeal("lost", "team", "active"),
  { party_id: id(401), state: "open", reviewed: null },
  { party_id: id(402), state: "open", reviewed: null },
];
const criticalDate = (n: number, due_on: string) => ({
  id: id(300 + n),
  deal_id: id(101),
  deal_name: "Example Deal 1",
  kind: "Due diligence ends",
  due_on,
  done: false,
});
const comingUpDates = [criticalDate(1, "2026-11-27"), criticalDate(2, today), criticalDate(3, "2026-12-10")];

async function openHome(
  t: TestContext,
  width: number,
  height: number,
  tours: unknown[] = [],
  dates = comingUpDates,
  home: typeof dashboard = dashboard,
) {
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
    route.fulfill({ json: home }),
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
  if (tours.length)
    await page.route("**/api/engine/calendar/meetings?*", (route) =>
      route.fulfill({
        json: {
          schema_version: "calendar-meetings.v1",
          meetings: [{ partner: "joe", name: "Joe", state: "empty", items: [] }],
          tours: { state: "ready", reason: null, items: tours },
        },
      }),
    );
  await page.route("**/api/engine/weekly-reviews?week_of=2026-11-23", (route) =>
    route.fulfill({ json: { items: reviewItems } }),
  );
  await page.route("**/api/engine/calendar/critical-dates", (route) =>
    route.fulfill({ json: { schema_version: "calendar-critical-dates.v1", critical_dates: dates } }),
  );
  await page.route("**/mcp", async (route) => {
    const call = route.request().postDataJSON();
    const board = call.params.name === "deal-room-board" && { board_from_engine: true, deals };
    const payload =
      call.params.name === "lead-board"
        ? { schema_version: "lead-workspace.v1", generated_at: "2026-11-25T15:00:00Z", leads }
        : {
            schema_version: "quiet-follow-ups.v1",
            cadence: { lead_days: 45, vendor_days: 90 },
            proposals: [
              { subject_type: "lead", subject_id: "lead-2", ref: null, name: "Sample Lead Two", basis: "created_at" },
            ].map((row) => ({ ...row, anchor_on: "2026-10-01", due_on: "2026-11-15", days_overdue: 10 })),
            sent: false,
            tasks_created: false,
          };
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: call.id,
        result: { content: [{ type: "text", text: JSON.stringify(board || payload) }] },
      },
    });
  });
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole("region", { name: "Reminders", exact: true }).waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));
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
    const region = (name: string) => box(page.getByRole("region", { name, exact: true }));
    const [left, middle, below] = [await box(reminders), await box(inbox), await box(waiting)];
    const right = await box(meetings);
    const leadsLine = await region("Leads");
    const column = [right, await region("Deals"), await region("Coming up"), leadsLine];
    assert.ok(left.x + left.width <= middle.x && middle.x + middle.width <= right.x, "three columns, left to right");
    assert.ok(Math.abs(below.x - middle.x) < 1 && below.y >= middle.y + middle.height, "waiting sits under Inbox");
    assert.ok(
      column.every((next, i) => {
        const above = column[i - 1];
        return Math.abs(next.x - right.x) < 1 && (!above || next.y >= above.y + above.height);
      }),
      "meetings, Deals, Coming up and Leads stack in the right column",
    );
    assert.ok(leadsLine.y + leadsLine.height <= height, "Leads is on the first screen");
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

test("On a phone Today's meetings comes first, Leads after Inbox, and In motion and waiting last", async (t) => {
  const page = await openHome(t, 390, 844);
  await page.getByRole("region", { name: "Today's meetings", exact: true }).waitFor();
  const tiles = await page.locator(".home-slice").evaluateAll((nodes) =>
    nodes
      .map((node) => ({ name: node.getAttribute("aria-label"), top: node.getBoundingClientRect().top }))
      .sort((a, b) => a.top - b.top)
      .map(({ name }) => name),
  );
  assert.deepEqual(tiles, [
    "Today's meetings",
    "Reminders",
    "Inbox",
    "Deals",
    "Coming up",
    "Leads",
    "In motion and waiting",
  ]);
});

test("The Leads line counts new and late leads and opens Leads", async (t) => {
  const page = await openHome(t, 1440, 900);
  const line = page.getByRole("region", { name: "Leads", exact: true }).getByRole("link");
  assert.equal(await line.textContent(), "Leads2 new from email · 1 follow-up late");
  assert.equal(await line.getAttribute("href"), "/leads");
});

test("At 1440 a waiting row keeps its whole return date and gives the rest to the title", async (t) => {
  const page = await openHome(t, 1440, 900);
  const row = page.getByRole("region", { name: "In motion and waiting", exact: true }).getByRole("article");
  const fits = (selector: string) =>
    row.locator(selector).evaluate((node) => ({ text: node.textContent, fits: node.scrollWidth <= node.clientWidth }));
  assert.deepEqual(await fits(".inbox-why"), { text: "Snoozed until Dec 1, 2026, 9:00 AM", fits: true });
  assert.deepEqual(await fits("h3"), { text: "Send the sample parking study", fits: true });
});

for (const [width, height] of [
  [1440, 900],
  [390, 844],
] as const)
  test(`At ${width} a tour row in Today's meetings shows Tour at the row start and its whole title`, async (t) => {
    const page = await openHome(t, width, height, [
      {
        id: "tour-1",
        deal_id: id(99),
        deal_name: "Example Dental",
        owner: "joe",
        planned_on: today,
        stop_count: 3,
        open_url: `/deals?deal=${id(99)}`,
      },
    ]);
    const row = page.getByRole("region", { name: "Today's meetings", exact: true }).locator(".home-tour");
    await row.waitFor();
    const rowLeft = (await row.boundingBox())?.x ?? assert.fail("the tour row is not drawn");
    const markLeft = (await row.locator(".home-today-time").boundingBox())?.x ?? assert.fail("Tour is not drawn");
    const title = row.locator(".home-today-title");
    const drawn = {
      markOffset: markLeft - rowLeft,
      titlePadding: await title.evaluate((node) => getComputedStyle(node).paddingInlineStart),
      titleText: await title.textContent(),
      titleCut: await title.evaluate((node) => node.scrollWidth > node.clientWidth),
    };
    assert.ok(drawn.markOffset < 16, `Tour sits at the row start, not ${drawn.markOffset}px in`);
    assert.equal(drawn.titlePadding, "0px");
    assert.equal(drawn.titleText, "Example Dental · 3 stops");
    assert.equal(drawn.titleCut, false, "the title is not cut off");
  });

test("Deals counts the Monday review's items and the board's phases, and Coming up lists the next 14 days, each opening what it counts", async (t) => {
  const page = await openHome(t, 1440, 900);
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  const link = (name: string) => tile.getByRole("link", { name, exact: true }).getAttribute("href");
  assert.equal(
    (await tile.getByRole("heading", { level: 2 }).textContent())?.replaceAll("\u00a0", " "),
    "Deals 3 open · 1 parked · 1 in national accounts · 2 prospects",
  );
  assert.equal(await link("3 open · 1 parked · 1 in national accounts · 2 prospects"), "/deals");
  assert.equal(await link("Research 1"), "/deals?column=research");
  assert.equal(await link("Example Deal 1 Step 3 days late"), `/deals?deal=${id(101)}`);
  assert.equal(await link("Example Deal 2 Flagged by a partner"), `/deals?deal=${id(102)}`);
  assert.equal(await link("1 has no next step"), "/deals?view=list&filter=no-next-step");
  assert.equal(await link("Monday review 1 of 8 includes 1 closed or lost this week"), "/deals?view=review");
  const comingUp = page.getByRole("region", { name: "Coming up", exact: true });
  assert.deepEqual(await comingUp.getByRole("link").allTextContents(), [
    "2",
    "Wed, Nov 25Due diligence ends · Example Deal 1",
    "Fri, Nov 27Due diligence ends · Example Deal 1",
  ]);
  assert.equal(await comingUp.getByRole("link", { name: "2", exact: true }).getAttribute("href"), "/calendar");
  assert.equal(await comingUp.getByRole("link").nth(1).getAttribute("href"), `/calendar?day=${today}`);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
] as const)
  test(`At ${width}x${height} the Deals heading holds a practice's counts in two lines, and the week's closings sit on the Monday review line`, async (t) => {
    const page = await openHome(t, width, height);
    const items = (count: number, state: string, workspace: string, operating: string) =>
      Array.from({ length: count }, () => reviewDeal(state, workspace, operating));
    const parties = Array.from({ length: 12 }, (_, n) => ({ party_id: id(410 + n), state: "open", reviewed: null }));
    const review = [
      ...items(37, "open", "team", "active"),
      ...items(27, "open", "team", "parked"),
      ...items(16, "open", "national_account", "active"),
      ...items(1, "lost", "team", "active"),
      ...parties,
      { party_id: id(430), state: "dropped", reviewed: null },
    ];
    await page.route("**/api/engine/weekly-reviews?week_of=2026-11-23", (route) =>
      route.fulfill({ json: { items: review } }),
    );
    await page.reload();
    const tile = page.getByRole("region", { name: "Deals", exact: true });
    const heading = tile.getByRole("heading", { level: 2 });
    await heading.getByText("37 open").waitFor();
    assert.equal(
      (await heading.textContent())?.replaceAll("\u00a0", " "),
      "Deals 37 open · 27 parked · 16 in national accounts · 12 prospects",
    );
    assert.ok(
      await heading.evaluate(
        (node) => node.getBoundingClientRect().height < 2.5 * parseFloat(getComputedStyle(node).lineHeight),
      ),
      "the heading is at most two lines",
    );
    assert.equal(
      (await tile.getByRole("link", { name: /^Monday review/ }).textContent())?.replaceAll("\u00a0", " "),
      "Monday review 0 of 94 includes 1 closed or lost and 1 dropped this week",
    );
    assert.ok(
      await tile.evaluate((node) => node.scrollWidth <= node.clientWidth),
      "nothing in Deals runs past the tile",
    );
  });

test("At 1280x640 the attention list and Coming up fold to one line each that opens in place", async (t) => {
  const page = await openHome(t, 1280, 640);
  const tile = page.getByRole("region", { name: "Deals", exact: true });
  assert.equal(
    await tile
      .getByRole("link", { name: /^Example Deal/ })
      .first()
      .isVisible(),
    false,
  );
  await tile.getByRole("button", { name: "2 need attention" }).click();
  await tile.getByRole("link", { name: "Example Deal 2 Flagged by a partner" }).waitFor();
  await page.getByRole("button", { name: "Coming up 2 dates in the next 14 days" }).click();
  await page.getByRole("link", { name: /Fri, Nov 27/ }).waitFor();
});

test("Coming up is not drawn when no open deal has a date in the next 14 days", async (t) => {
  const page = await openHome(
    t,
    1440,
    900,
    [],
    [criticalDate(4, "2026-12-10"), { ...criticalDate(5, today), done: true }],
  );
  assert.equal(await page.getByRole("region", { name: "Coming up", exact: true }).count(), 0);
  assert.equal(await page.getByText("Coming up").count(), 0);
});

test("A reminder's action reads in full on line one instead of its cut heading", async (t) => {
  const page = await openHome(t, 1280, 640);
  const row = page.getByRole("region", { name: "No date" }).getByRole("article");
  const title = row.getByRole("heading", { level: 3 });
  assert.equal(await title.textContent(), longInstruction);
  assert.equal(await row.locator(".inbox-why").textContent(), "Example Dental");
  assert.ok(
    await title.evaluate((node) => node.scrollWidth <= node.clientWidth && node.scrollHeight <= node.clientHeight),
    "the action is not clipped",
  );
  assert.equal(await page.evaluate(() => document.scrollingElement?.scrollHeight), 640, "the page does not scroll");
});

test("An opened Inbox item shows beside Reminders over the middle and right columns, and Close brings them back", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("button", { name: "Review" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  const left = (await reminders.boundingBox()) ?? assert.fail("Reminders left the screen");
  const pane = (await details.boundingBox()) ?? assert.fail("the item is not drawn");
  assert.ok(pane.x >= left.x + left.width, "the item opens right of Reminders");
  assert.ok(pane.x + pane.width > 1300, "the item spans the right columns");
  assert.equal(await page.getByRole("region", { name: "Deals", exact: true }).isVisible(), false);
  await details.getByRole("button", { name: /^Close/ }).click();
  await inbox.waitFor();
  assert.equal(await details.count(), 0);
});

for (const [kind, fields] of [
  [
    "a vendor check-in",
    {
      title: "Check in with Sample Signs",
      context_label: "Sample Signs",
      open_url: `/relationships?node=party:${id(600)}&focus=next-step`,
      deal_id: null,
      record: `/relationships?node=party:${id(600)}&focus=next-step`,
    },
  ],
  [
    "a deal's next step",
    { title: "Send the sample site plan", record: `/deals?deal=${id(99)}&focus=next-step&step=${id(30)}` },
  ],
  [
    "a checklist item",
    {
      title: "Order the sample survey",
      primary_action: "Open checklist item",
      checklist_item_ref: `deal-item:${id(601)}`,
      record: `/deals?deal=${id(99)}&item=${id(601)}`,
    },
  ],
] as const)
  test(`Clicking ${kind} in Reminders opens it beside the list with a link to its record, never another page`, async (t) => {
    const reminder = card(30, fields.title, fields);
    const page = await openHome(t, 1440, 900, [], comingUpDates, {
      ...dashboard,
      reminders: group([...dashboard.reminders.items, reminder]),
    });
    const home = page.url();
    await page
      .getByRole("region", { name: "Reminders", exact: true })
      .getByRole("link", { name: fields.title })
      .click();
    const details = page.getByRole("region", { name: `Details for ${fields.title}` });
    await details.waitFor();
    assert.equal(new URL(page.url()).pathname, new URL(home).pathname, "Home stays on screen");
    const left = (await page.getByRole("region", { name: "Reminders", exact: true }).boundingBox()) ?? assert.fail();
    assert.ok(((await details.boundingBox()) ?? assert.fail()).x >= left.x + left.width, "it opens right of Reminders");
    const links = await details
      .locator("a.inbox-source")
      .evaluateAll((nodes) => nodes.map((node) => node.getAttribute("href")));
    assert.ok(links.includes(fields.record), `the pane links to ${fields.record}, not ${links}`);
  });

test("An opened reminder has its own Mark done, which saves it as the row's circle does", async (t) => {
  const page = await openHome(t, 1440, 900);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  assert.equal(await reminders.locator("button.home-done").first().isEnabled(), true, "the circle works while closed");
  await reminders.getByRole("link", { name: "Call the sample practice" }).click();
  const details = page.getByRole("region", { name: "Details for Call the sample practice" });
  const saved = page.waitForRequest((request) => request.method() === "POST" && !!request.postData()?.includes(id(1)));
  await details.getByRole("button", { name: "Mark done", exact: true }).click();
  await saved;
});

test("On a phone an opened item covers the screen, and Back returns to the list where it was", async (t) => {
  const page = await openHome(t, 390, 844);
  const title = page
    .getByRole("region", { name: "Reminders", exact: true })
    .getByRole("link", { name: "Call the sample practice" });
  await title.scrollIntoViewIfNeeded();
  await page.evaluate(() => scrollBy(0, 120));
  const scrolled = await page.evaluate(() => scrollY);
  assert.ok(scrolled > 0, "the list is scrolled");
  await title.click();
  const details = page.getByRole("region", { name: "Details for Call the sample practice" });
  await details.waitFor();
  assert.deepEqual(await details.boundingBox(), { x: 0, y: 0, width: 390, height: 844 }, "the item is full screen");
  await details.getByRole("button", { name: "Back", exact: true }).click();
  assert.equal(await details.count(), 0);
  assert.equal(await page.evaluate(() => scrollY), scrolled, "the list is where it was");
});

test("Escape closes an opened Inbox item and focus returns to its row", async (t) => {
  const page = await openHome(t, 1440, 900);
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const review = inbox.getByRole("button", { name: "Review" });
  await review.click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  await page.mouse.click(5, 5);
  await page.keyboard.press("Escape");
  await inbox.waitFor();
  assert.equal(await details.count(), 0);
  const focused = await page.evaluate(() => {
    const active = document.activeElement;
    return { tag: active?.tagName, row: active?.closest("[data-inbox-row]")?.textContent ?? null };
  });
  assert.match(focused.row ?? "", /Send your reply to the sample practice/, "focus is back on its row");
});

test("In light mode at 1440x900 Home and an opened item draw light grounds with readable text", async (t) => {
  const page = await openHome(t, 1440, 900);
  await page.addInitScript(() =>
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ theme: "light", walkthroughSeen: { joe: true } }),
    ),
  );
  await page.reload();
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("button", { name: "Review" }).click();
  const details = page.getByRole("region", { name: "Details for Send your reply to the sample practice" });
  await details.waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.dataset.theme), "light");
  const drawn = await details.evaluate((node) => {
    const channels = (color: string) => (color.match(/[\d.]+/g) ?? []).slice(0, 3).map(Number);
    const luminance = (color: string) => {
      const [r = 0, g = 0, b = 0] = channels(color).map((value) => {
        const unit = value / 255;
        return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const ground = getComputedStyle(document.body).backgroundColor;
    const heading = getComputedStyle(node.querySelector("h4") ?? node).color;
    const [light, dark] = [luminance(ground), luminance(heading)].sort((a, b) => b - a);
    return { ground: luminance(ground), contrast: ((light ?? 0) + 0.05) / ((dark ?? 0) + 0.05) };
  });
  assert.ok(drawn.ground > 0.5, `the page ground is light, not ${drawn.ground}`);
  assert.ok(drawn.contrast >= 4.5, `the item heading reads at ${drawn.contrast}:1`);
  await page.screenshot({ path: join(process.cwd(), "node_modules/.cache/home-light-1440.png") });
});

test("On a phone the Inbox previews its first rows with See all, like Reminders", async (t) => {
  const inboxRows = [1, 2, 3, 4, 5, 6].map((n) => reply(30 + n, `Send your reply to sample practice ${n}`));
  const page = await openHome(t, 390, 844, [], comingUpDates, { ...dashboard, inbox: group(inboxRows) });
  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  await inbox.getByRole("button", { name: "See all 6" }).waitFor();
  assert.equal(await inbox.getByRole("article").count(), 4);
  await inbox.getByRole("button", { name: "See all 6" }).click();
  assert.equal(await inbox.getByRole("article").count(), 6);
});
