import assert from "node:assert/strict";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
before(async () => {
  const outDir = temporaryDirectory("home-reminders-title-");
  await buildArtifact({ root: process.cwd(), outDir });
  server = await ownedFixtureServer({ root: join(outDir, "site") });
});
after(() => server?.close());

const today = "2026-11-25";
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const title = "Ask the sample landlord to confirm terms and the parking options before Friday";

const reminder = {
  item_id: `next_action:${id(1)}`,
  card_id: `next_action:${id(1)}`,
  source_type: "next_action",
  source_id: id(1),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  why: "The sample practice asked for it",
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
  open_url: `/deals?deal=${id(99)}&focus=next-step&step=${id(1)}`,
  deal_id: id(99),
  kind_label: "Task",
  action_id: id(1),
  action_version: 1,
  merged_source_ids: [id(1)],
  waiting_version: 0,
  waiting_on: null,
  source_activity: null,
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
  tile: "reminders",
};

const inboxItem = {
  ...reminder,
  item_id: `suggestion:${id(2)}`,
  card_id: `suggestion:${id(2)}`,
  source_type: "email_proposal",
  source_id: id(2),
  title: "Send your reply to the sample practice",
  action_id: null,
  action_version: null,
  deal_id: null,
  open_url: null,
  kind_label: "Suggestion",
  primary_action: "Review suggestions",
  tile: "inbox",
  merged_source_ids: [id(2)],
};

const dashboard = {
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: { count: 1, items: [reminder] },
  inbox: { count: 1, items: [inboxItem] },
  waiting: { count: 0, items: [] },
};

const firstLineCharacterCount = (root: Element) => {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let firstTop: number | undefined;
  let count = 0;
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const value = node.nodeValue ?? "";
    for (let i = 0; i < value.length; i += 1) {
      const range = document.createRange();
      range.setStart(node, i);
      range.setEnd(node, i + 1);
      const rect = range.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;
      if (firstTop === undefined) firstTop = rect.top;
      if (rect.top > firstTop + 1) return count;
      count += 1;
    }
  }
  return count;
};

test("a long Reminders title shows at least 40 characters on its first line at 1024x768 in three columns, and hovering the row does not change its height", {
  timeout: 180_000,
}, async (t: TestContext) => {
  assert.ok(title.length >= 60, "the seeded title is long enough to wrap");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1024, height: 768 }, timezoneId: "America/Chicago" });
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
  await page.route("**/api/engine/weekly-reviews?week_of=2026-11-23", (route) =>
    route.fulfill({ json: { items: [] } }),
  );
  await page.route("**/api/engine/calendar/critical-dates", (route) =>
    route.fulfill({ json: { schema_version: "calendar-critical-dates.v1", critical_dates: [] } }),
  );
  await page.route("**/mcp", async (route) => {
    const call = route.request().postDataJSON();
    const payload =
      call.params.name === "deal-room-board"
        ? { board_from_engine: true, deals: [] }
        : call.params.name === "lead-board"
          ? { schema_version: "lead-workspace.v1", generated_at: "2026-11-25T15:00:00Z", leads: [] }
          : {
              schema_version: "quiet-follow-ups.v1",
              cadence: { lead_days: 45, vendor_days: 90 },
              proposals: [],
              sent: false,
              tasks_created: false,
            };
    await route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: call.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      },
    });
  });
  await page.goto(`${server.origin}/?mode=live`);
  const reminders = page.getByRole("region", { name: "Reminders", exact: true });
  await reminders.waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));

  const inbox = page.getByRole("region", { name: "Inbox", exact: true });
  const side = page.getByRole("region", { name: "Today's meetings", exact: true });
  const left = (await reminders.boundingBox()) ?? assert.fail("Reminders is not drawn");
  const middle = (await inbox.boundingBox()) ?? assert.fail("Inbox is not drawn");
  const right = (await side.boundingBox()) ?? assert.fail("the day column is not drawn");
  assert.ok(left.x + left.width <= middle.x && middle.x + middle.width <= right.x, "three columns, left to right");

  const row = reminders.locator("article.inbox-row").filter({ hasText: title });
  await row.getByRole("button", { name: "Snooze", exact: true }).waitFor();
  await row.getByRole("button", { name: "Drop", exact: true }).waitFor();

  const heading = row.locator("h3");
  const firstLine = await heading.evaluate(firstLineCharacterCount);
  assert.ok(firstLine >= 40, `the first line shows ${firstLine} characters, expected at least 40`);

  const heightBefore = await row.evaluate((node) => node.getBoundingClientRect().height);
  await row.hover();
  const heightAfter = await row.evaluate((node) => node.getBoundingClientRect().height);
  assert.equal(heightAfter, heightBefore, "hovering the row does not change its height");
});
