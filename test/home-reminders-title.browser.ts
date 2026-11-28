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

const reminderAt = (n: number) => ({
  item_id: `next_action:${id(n)}`,
  card_id: `next_action:${id(n)}`,
  source_type: "next_action",
  source_id: id(n),
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title: n === 1 ? title : `${title}, item ${n}`,
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
});
const reminder = reminderAt(1);

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

const dashboardWith = (reminders: (typeof reminder)[]) => ({
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: { count: reminders.length, items: reminders },
  inbox: { count: 1, items: [inboxItem] },
  waiting: { count: 0, items: [] },
});

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

async function openHome(
  browser: Awaited<ReturnType<typeof chromium.launch>>,
  { reminders = 1, hasTouch = false }: { reminders?: number; hasTouch?: boolean } = {},
) {
  const items = Array.from({ length: reminders }, (_, n) => reminderAt(n + 1));
  const context = await browser.newContext({
    viewport: { width: 1024, height: 768 },
    timezoneId: "America/Chicago",
    hasTouch,
  });
  const page = await context.newPage();
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
    route.fulfill({ json: dashboardWith(items) }),
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
  const region = page.getByRole("region", { name: "Reminders", exact: true });
  await region.waitFor();
  await page.waitForFunction(() => !document.querySelector(".home-placeholder"));
  return { page, region };
}

test("a long Reminders title shows at least 40 characters on its first line at 1024x768 in three columns, and hovering the row does not change its height", {
  timeout: 180_000,
}, async (t: TestContext) => {
  assert.ok(title.length >= 60, "the seeded title is long enough to wrap");
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, region: reminders } = await openHome(browser);

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

test("with a pointer, hidden Snooze and Drop take no clicks and the keyboard-focused overlay matches its row", {
  timeout: 180_000,
}, async (t: TestContext) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, region } = await openHome(browser);
  const row = region.locator("article.inbox-row").filter({ hasText: title });
  const actions = row.locator(".inbox-actions");
  await page.mouse.move(0, 0);

  const hiddenHit = await actions.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return (
      document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2)?.closest(".inbox-actions") !== null
    );
  });
  assert.equal(hiddenHit, false, "a click where hidden Snooze and Drop sit does not reach them");

  await row.getByRole("button", { name: "Snooze", exact: true }).focus();
  await row.evaluate((node) => Promise.all(node.getAnimations().map((animation) => animation.finished)));
  const overlay = await actions.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, shadow: style.boxShadow, radius: style.borderRadius };
  });
  const rowStyle = await row.evaluate((node) => {
    const style = getComputedStyle(node);
    return { background: style.backgroundColor, radius: style.borderRadius };
  });
  assert.equal(
    overlay.background,
    rowStyle.background,
    "focus without hover paints the overlay in the row's own background",
  );
  assert.ok(
    overlay.shadow.startsWith(rowStyle.background) && /-\d+px 0px [1-9]\d*px/.test(overlay.shadow),
    "the overlay feathers its left edge in the row's background",
  );
  assert.equal(overlay.radius, rowStyle.radius, "the overlay keeps the row's corner radius");
});

test("a click on the right of a Reminders title opens it, and the sticky header stays over a focused row's actions", {
  timeout: 180_000,
}, async (t: TestContext) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, region } = await openHome(browser, { reminders: 30 });
  const row = region.locator("article.inbox-row").first();
  const link = row.locator("h3 a");
  const linkBox = (await link.boundingBox()) ?? assert.fail("the title link is not drawn");
  const actionsBox = (await row.locator(".inbox-actions").boundingBox()) ?? assert.fail("actions are not drawn");
  const clickX = actionsBox.x - 4;
  assert.ok(clickX > linkBox.x + linkBox.width / 2, "the click lands on the right half of the title");
  const y = linkBox.y + 8;
  await page.mouse.move(clickX, y);
  const hit = await page.evaluate(
    ({ x, top }) => document.elementFromPoint(x, top)?.closest("h3 a")?.getAttribute("href"),
    { x: clickX, top: y },
  );
  assert.match(hit ?? "", /^\/inbox\/card\//, "a click there lands on the title link, not on Snooze");
  const header = region.locator(":scope > header");
  const target = region.locator("article.inbox-row").nth(10);
  const headerBox = (await header.boundingBox()) ?? assert.fail("the header is not drawn");
  const targetTop = (await target.boundingBox())?.y ?? assert.fail("the tenth row is not drawn");
  await region.evaluate(
    (node, delta) => node.scrollTo({ top: node.scrollTop + delta, behavior: "instant" }),
    targetTop - (headerBox.y + headerBox.height) + 20,
  );
  await page.mouse.move(0, 0);
  const beforeFocus = await region.evaluate((node) => node.scrollTop);
  await target.getByRole("button", { name: "Snooze", exact: true }).evaluate((node) => {
    if (node instanceof HTMLElement) node.focus({ preventScroll: true });
  });
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  assert.equal(await region.evaluate((node) => node.scrollTop), beforeFocus);
  const stuck = (await header.boundingBox()) ?? assert.fail("the header is not drawn");
  const overlay = (await target.locator(".inbox-actions").boundingBox()) ?? assert.fail("actions are not drawn");
  const probe = { x: overlay.x + overlay.width / 2, y: stuck.y + stuck.height - 2 };
  assert.ok(overlay.y < probe.y, "the focused row's actions reach under the sticky header");
  assert.ok(
    await header.evaluate((node, point) => node.contains(document.elementFromPoint(point.x, point.y)), probe),
    "the sticky header paints over the actions",
  );
});

test("by touch, Snooze and Drop stay reachable without hovering", { timeout: 180_000 }, async (t: TestContext) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, region } = await openHome(browser, { hasTouch: true });
  const none = await page.evaluate(() => matchMedia("(hover: none)").matches);
  assert.ok(none, "the emulated device cannot hover");
  const row = region.locator("article.inbox-row").filter({ hasText: title });
  for (const name of ["Snooze", "Drop"]) {
    const button = row.getByRole("button", { name, exact: true });
    assert.equal(
      await button.evaluate((node) => getComputedStyle(node.closest(".inbox-actions") ?? node).opacity),
      "1",
    );
    assert.ok(await button.isVisible(), `${name} is visible`);
    assert.ok(
      await button.evaluate((node) => {
        const box = node.getBoundingClientRect();
        return document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2) === node;
      }),
      `${name} takes the tap`,
    );
  }
});
