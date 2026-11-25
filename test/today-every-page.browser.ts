import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import test, { after, before, type TestContext } from "node:test";
import { routeContract } from "../js/routes.js";
import { buildArtifact } from "../scripts/artifact.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedFixtureServer>>;
let mondayReview: string;
before(async () => {
  const outDir = temporaryDirectory("today-pages-");
  await buildArtifact({ root: process.cwd(), outDir });
  const site = join(outDir, "site");
  mondayReview = await readFile(join(site, "monday-review.html"), "utf8");
  server = await ownedFixtureServer({ root: site });
});
after(() => server?.close());

const legacyVerbs = new Set([
  "morning-brief",
  "today-triage",
  "calendar-meeting-prep",
  "list-email-thread-filings",
  "undo-email-thread-filing",
]);
const id = "00000000-0000-4000-8000-000000000001";
const pages = [
  ...Object.keys(routeContract.routes)
    .filter((path) => !["/", "/client-portal", "/calendar"].includes(path))
    .map((path) => path.replace(":boardId", "carr-v5").replace(/:\w+/g, id)),
  "/?view=charts",
  "/deals?view=national",
  "/deals?view=review",
  "/deals?view=dropped-prospect",
  "/tours/day.html",
  "/tours/route-editor.html",
];

// A browser already bound to this session keeps its saved panel choices instead of clearing them on first sign-in.
const binding = createHash("sha256")
  .update(JSON.stringify(["joe", "synthetic"]))
  .digest("hex");
const withHomeSwitch = (html: string) => html.replace("<html ", "<html data-home-today-from-engine ");

async function open(
  t: TestContext,
  path: string,
  {
    enabled = true,
    width = 1440,
    recentChanges = false,
    malformedEndedReminder = false,
    meetingState = "ready",
    meetingItems = true,
    meetingsMayBeMissing,
    todayStatus = 200,
    theme = "dark",
  }: {
    enabled?: boolean;
    width?: number;
    recentChanges?: boolean;
    malformedEndedReminder?: boolean;
    meetingState?: string;
    meetingItems?: boolean;
    meetingsMayBeMissing?: boolean | string | null | undefined;
    todayStatus?: number;
    theme?: string;
  } = {},
) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: 900 },
    timezoneId: "America/Chicago",
    reducedMotion: "reduce",
  });
  if (recentChanges) {
    await page.clock.setFixedTime(new Date("2026-11-19T17:00:00Z"));
    await page.route("**/pipeline/changes*", (route) =>
      route.fulfill({
        json: {
          cursor: "1",
          events: new URL(route.request().url()).searchParams.has("cursor")
            ? []
            : [
                {
                  id: "example-change",
                  subject_type: "deal",
                  subject_id: id,
                  field: "next_step",
                  actor: "dell",
                  new_value: "Review sample terms",
                  recorded_at: "2026-11-19T16:59:00Z",
                },
              ],
        },
      }),
    );
  }
  const legacy: string[] = [];
  const readToday: string[] = [];
  await page.addInitScript(
    ({ theme, binding }) => {
      localStorage.setItem("doctorcre-session-binding-v1", binding);
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
      localStorage.setItem("doctorcre:sidebar:/invoices", "open");
      for (const page of [location.pathname, "/deals?view=national", "/deals?view=review"])
        localStorage.setItem(`doctorcre:today:${page}`, "open");
    },
    { theme, binding },
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/mcp", (route) => {
    const { name } = route.request().postDataJSON().params;
    if (legacyVerbs.has(name)) legacy.push(name);
    const payload =
      name === "deal-room-board"
        ? { actor: "joe", deals: recentChanges ? [{ id, name: "Example Deal", phase: "pending", owner: "joe" }] : [] }
        : name === "capture-queue" && recentChanges
          ? { candidates: [{ id: "example-capture", kind: "meeting_record" }] }
          : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } });
  });
  await page.route("**/api/engine/home/inbox?view=dashboard", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-inbox.v5",
        home_mark_drop: true,
        home_proposal_drop: true,
        reminders: { count: 1, items: [{ item_id: "example-reminder", card_id: "example-reminder" }] },
        waiting: { count: 0, items: [] },
      },
    }),
  );
  await page.route("**/api/engine/home/today", (route) => {
    readToday.push(route.request().method());
    if (todayStatus !== 200) return route.fulfill({ status: todayStatus });
    return route.fulfill({
      json: {
        ok: true,
        schema_version: "home-today.v1",
        viewer: "joe",
        partners: [
          { slug: "joe", name: "Joe" },
          { slug: "dell", name: "Dell" },
        ],
        today: "2026-11-19",
        meetings: {
          state: meetingState,
          ...(meetingsMayBeMissing === undefined ? {} : { meetings_may_be_missing: meetingsMayBeMissing }),
          observed_at: "2026-11-19T21:40:00Z",
          notes: ["Internal calendar instruction"],
          items:
            meetingState !== "empty" && meetingItems
              ? [
                  {
                    title: "Example site visit",
                    start: "2026-11-19T16:00:00Z",
                    end: "2026-11-19T17:00:00Z",
                    context_label: "Example Dental",
                    attendees: [{ name: "Example Attendee" }],
                    open_url: "/deals?deal=example",
                  },
                ]
              : [],
          follow_up_reviews: [],
        },
        reminders: {
          state: "ready",
          late: [
            {
              kind: "step",
              owner: "joe",
              title: "Send sample floor plan",
              why: "Check the suite number before sending.",
              due_on: "2026-11-16",
              days_late: 3,
              late_label: "3 days late",
              home_item_id: "example-reminder",
            },
            {
              kind: "step",
              owner: "joe",
              title: "Call the example lead",
              due_on: "2026-11-16",
              home_item_id: "example-lead-step",
              open_url: "/leads?lead=example",
            },
            {
              kind: "step",
              owner: "joe",
              title: "Check in with the supplier",
              why: null,
              due_on: "2026-11-16",
              home_item_id: "example-vendor-step",
              open_url: "/relationships?node=party:example",
            },
            {
              kind: "step",
              owner: "joe",
              title: "Check the former office",
              due_on: "2026-11-15",
              days_late: 4,
              late_label: "4 days late",
              deal_ended: malformedEndedReminder ? "true" : true,
            },
          ],
          upcoming: [],
        },
      },
    });
  });
  const url = new URL(path, server.origin);
  url.searchParams.set("mode", "live");
  await page.route(url.href, async (route) => {
    if (!enabled || !route.request().isNavigationRequest()) return route.fallback();
    if (path === "/deals?view=review" || path === "/deals?view=dropped-prospect") {
      return route.fulfill({ contentType: "text/html", body: withHomeSwitch(mondayReview) });
    }
    const response = await route.fetch();
    return route.fulfill({ response, body: withHomeSwitch(await response.text()) });
  });
  const navigation = await page.goto(url.href, { waitUntil: "domcontentloaded" });
  // The rendered suggestion confirms the initial feed read finished before reconnecting.
  if (recentChanges)
    await page.locator('#confirmDock [data-proposal="example-capture"]').waitFor({ state: "attached" });
  assert.equal(navigation?.status(), 200);
  return { page, today: page.getByRole("complementary", { name: "Today", exact: true }), legacy, readToday };
}

test("Today opens the record when a reminder is missing from the Home grid", async (t) => {
  const { today } = await open(t, "/invoices");
  const link = today.getByRole("link", { name: /Check in with the supplier/ });
  await link.waitFor();
  assert.equal(await link.getAttribute("href"), "/relationships?node=party:example");
  assert.equal(await today.getByText("Check in with the supplier", { exact: true }).count(), 1);
});

test("Today keeps lead reminders on Leads", async (t) => {
  const { today } = await open(t, "/leads");
  await today.getByText("Send sample floor plan", { exact: true }).waitFor();
  assert.equal(await today.getByText("Call the example lead", { exact: true }).count(), 0);
});

for (const path of pages)
  test(`Engine Today on ${path}`, async (t) => {
    const { page, today, legacy, readToday } = await open(t, path);
    const rail = path === "/tours/day.html" ? page.locator("#appToday") : today;
    await rail.getByText("Meetings", { exact: true }).waitFor({ state: "attached", timeout: 10000 });
    await rail.getByText("Example site visit", { exact: true }).waitFor({ state: "attached" });
    await rail.getByText("Late", { exact: true }).waitFor({ state: "attached" });
    assert.equal(
      await rail.getByText("Send sample floor plan", { exact: true }).locator("..").getAttribute("href"),
      "/?card=example-reminder",
    );
    assert.equal(await rail.getByText("Joe · 3 days late", { exact: true }).count(), 1);
    assert.equal(await page.getByText("Example site visit", { exact: true }).count(), 1);
    assert.equal(
      await page
        .getByRole("heading", { name: /^(Your calendar|Upcoming meetings|Your working week|Your schedule)$/ })
        .count(),
      0,
    );
    assert.equal(await page.locator("#homeCalendar, #homeMeetings, #homeMeetingReviews").count(), 0);
    assert.equal(await page.locator("#docMorning, #docMorningBrief").count(), 0);
    assert.deepEqual(readToday, ["GET"]);
    assert.deepEqual(legacy, []);
  });

test("Today leaves an ended deal's reminder out on Deals", async (t) => {
  const deals = await open(t, "/deals?view=national");
  await deals.today.getByText("Send sample floor plan", { exact: true }).waitFor();
  assert.equal(await deals.today.getByText("Check the former office", { exact: true }).count(), 0);
  assert.equal(await deals.today.getByText("Joe · 4 days late", { exact: true }).count(), 0);
});

test("Today rejects a reminder with a malformed ended-deal marker", async (t) => {
  const { today } = await open(t, "/deals?view=national", { malformedEndedReminder: true });
  await today.getByText("Example site visit", { exact: true }).waitFor();
  assert.equal(await today.getByText("Couldn't load dated reminders.", { exact: true }).count(), 1);
  assert.equal(await today.getByText("Check the former office", { exact: true }).count(), 0);
});

test("Today uses the engine without the former page marker and the shell omits Morning brief", async (t) => {
  const { page, today, legacy, readToday } = await open(t, "/invoices", { enabled: false });
  await today.getByText("Example site visit", { exact: true }).waitFor({ timeout: 3000 });
  assert.equal(await page.getByRole("button", { name: "Workspace sidebar", exact: true }).isVisible(), true);
  assert.equal(await page.locator("#docOpen").count(), 0);
  assert.deepEqual(readToday, ["GET"]);
  assert.deepEqual(legacy, []);

  const on = await open(t, "/invoices");
  await on.today.getByText("Example site visit", { exact: true }).waitFor();
  assert.equal(await on.page.getByRole("button", { name: "Morning brief", exact: true }).count(), 0);
  assert.equal(await on.page.locator("#docMorningBrief").count(), 0);
  assert.deepEqual(on.legacy, []);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"]) {
    test(`Today shows meetings and reminder filters at ${width}px in ${theme}`, async (t) => {
      const { page, today } = await open(t, "/invoices", {
        width,
        theme,
        meetingState: "partial",
        meetingsMayBeMissing: true,
      });
      if (width === 390) await page.getByRole("button", { name: "Today sidebar", exact: true }).click();
      const meetings = today.getByRole("region", { name: "Meetings", exact: true });
      await meetings.getByText("Example site visit", { exact: true }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(
        await meetings.getByText(/Check Outlook|Internal calendar instruction|Calendar may be incomplete/).count(),
        0,
      );
      assert.equal(await meetings.getByText(/Last synced/).count(), 0);
      const owners = today.getByRole("group", { name: "Reminders for" });
      const both = owners.getByRole("button", { name: "Both partners" });
      const dell = owners.getByRole("button", { name: "Dell" });
      assert.equal(await both.getAttribute("aria-pressed"), "true");
      await dell.click();
      assert.equal(await dell.getAttribute("aria-pressed"), "true");
      await today.getByText("No dated reminders.", { exact: true }).waitFor();
      await both.click();
      await today.getByText("Send sample floor plan", { exact: true }).waitFor();
      await today.getByText("Check the suite number before sending.", { exact: true }).waitFor();
      if (process.env.PARTNER_MENU_SCREENSHOT_DIR) {
        await mkdir(process.env.PARTNER_MENU_SCREENSHOT_DIR, { recursive: true });
        await today.screenshot({ path: join(process.env.PARTNER_MENU_SCREENSHOT_DIR, `today-${width}-${theme}.png`) });
      }
    });
  }

for (const [meetingState, meetingsMayBeMissing] of [
  ["empty", undefined],
  ["empty", false],
  ["partial", false],
  ["partial", true],
] as const) {
  test(`Today shows an empty calendar (${meetingState}, missing meetings: ${meetingsMayBeMissing})`, async (t) => {
    const { today } = await open(t, "/invoices", { meetingState, meetingItems: false, meetingsMayBeMissing });
    await today.getByText("Send sample floor plan", { exact: true }).waitFor();
    const meetings = today.getByRole("region", { name: "Meetings", exact: true });
    assert.equal(await meetings.getByText("No meetings today.", { exact: true }).count(), 1);
    assert.equal(
      await meetings.getByText("Calendar may be incomplete", { exact: true }).count(),
      Number(meetingsMayBeMissing === true),
    );
    assert.equal(
      await meetings
        .getByText(/Couldn't load meetings|Check Outlook|Last synced|Internal calendar instruction/)
        .count(),
      0,
    );
  });
}

for (const { meetingsMayBeMissing, meetingItems } of [
  { meetingsMayBeMissing: "false", meetingItems: false },
  { meetingsMayBeMissing: null, meetingItems: true },
]) {
  test(`Today rejects a malformed calendar flag (${JSON.stringify(meetingsMayBeMissing)})`, async (t) => {
    const { today } = await open(t, "/invoices", { meetingsMayBeMissing, meetingItems });
    await today.getByText("Send sample floor plan", { exact: true }).waitFor();
    const meetings = today.getByRole("region", { name: "Meetings", exact: true });
    assert.equal(await meetings.getByText("Couldn't load meetings.", { exact: true }).count(), 1);
    assert.equal(
      await meetings.getByText(/No meetings today|Calendar may be incomplete|Example site visit/).count(),
      0,
    );
  });
}

for (const meetingState of ["unavailable", "invalid"]) {
  test(`Today reports an unavailable calendar (${meetingState} section)`, async (t) => {
    const { today } = await open(t, "/invoices", { meetingState, meetingItems: false });
    await today.getByText("Send sample floor plan", { exact: true }).waitFor();
    const meetings = today.getByRole("region", { name: "Meetings", exact: true });
    assert.equal(await meetings.getByText("Couldn't load meetings.", { exact: true }).count(), 1);
    assert.equal(
      await meetings.getByText(/No meetings today|Calendar may be incomplete|Check Outlook|Last synced/).count(),
      0,
    );
  });
}

test("Today reports an unavailable calendar when the request fails", async (t) => {
  const { today } = await open(t, "/invoices", { todayStatus: 503 });
  const meetings = today.getByRole("region", { name: "Meetings", exact: true });
  await meetings.getByText("Couldn't load meetings.", { exact: true }).waitFor();
  assert.equal(await meetings.getByText(/No meetings today|Calendar may be incomplete/).count(), 0);
});

for (const width of [1440, 390])
  test(`Open a meeting on Invoices at ${width}px`, async (t) => {
    const { page, today, legacy } = await open(t, "/invoices", { width });
    assert.equal(await page.getByRole("button", { name: "Workspace sidebar", exact: true }).count(), 0);
    assert.equal(await page.locator("#appSidebar").isVisible(), false);
    assert.equal(await page.locator("#appLayout").getAttribute("data-sidebar"), "closed");
    if (width === 390) await page.getByRole("button", { name: "Today sidebar", exact: true }).click();
    await today.getByText("Example site visit", { exact: true }).click();
    await today.getByText("Attendees: Example Attendee", { exact: true }).waitFor();
    assert.match(
      (await today.getByText("Example site visit", { exact: true }).locator("..").textContent()) ?? "",
      /10:00 AM/,
    );
    assert.equal(
      await today.getByRole("link", { name: "Open deal", exact: true }).getAttribute("href"),
      "/deals?deal=example",
    );
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    assert.ok(
      await today.evaluate((rail) => rail.scrollWidth <= rail.clientWidth),
      "Meeting and reminder cards fit inside Today",
    );
    assert.deepEqual(legacy, []);
    if (process.env.TODAY_SCREENSHOT_DIR) {
      await mkdir(process.env.TODAY_SCREENSHOT_DIR, { recursive: true });
      await today.screenshot({ path: join(process.env.TODAY_SCREENSHOT_DIR, `today-${width}.png`) });
    }
  });

for (const width of [1440, 390]) {
  test(`National Recent changes stays visible with Home on and Deals off at ${width}px`, async (t) => {
    const { page } = await open(t, "/deals?view=national", { width, recentChanges: true });
    await page.evaluate(() => window.dispatchEvent(new Event("online")));
    const jump = page.getByRole("button", { name: /Go to recent changes/ });
    await jump.click({ timeout: 10000 });
    const receipts = page.getByRole("region", { name: "Recent changes", exact: true });
    await receipts.getByText(/Review sample terms/).waitFor();
    assert.equal(await page.locator("#receiptsTitle").evaluate((title) => title === document.activeElement), true);
    assert.equal(await receipts.evaluate((panel) => Boolean(panel.closest("#appMainSlot"))), true);
    assert.equal(await receipts.evaluate((panel) => panel.getBoundingClientRect().top < innerHeight), true);
  });
}
