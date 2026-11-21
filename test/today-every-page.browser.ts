import assert from "node:assert/strict";
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

const legacyVerbs = new Set(["morning-brief", "today-triage", "calendar-meeting-prep"]);
const id = "00000000-0000-4000-8000-000000000001";
const pages = [
  ...Object.keys(routeContract.routes)
    .filter((path) => !["/", "/share", "/client-portal"].includes(path))
    .map((path) => path.replace(":boardId", "carr-v5").replace(/:\w+/g, id)),
  "/deals?view=national",
  "/deals?view=review",
  "/deals?view=dropped-prospect",
  "/tours/day.html",
  "/tours/route-editor.html",
];

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
    theme = "dark",
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
    await page.clock.install({ time: new Date("2026-11-19T17:00:00Z") });
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
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
    localStorage.setItem("doctorcre:sidebar:/invoices", "open");
  }, theme);
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/mcp", (route) => {
    const { name } = route.request().postDataJSON().params;
    if (legacyVerbs.has(name)) legacy.push(name);
    const payload =
      name === "deal-room-board"
        ? { actor: "joe", deals: recentChanges ? [{ id, name: "Example Deal", phase: "pending", owner: "joe" }] : [] }
        : name === "calendar-meeting-prep"
          ? { state: "empty", items: [] }
          : { items: [] };
    return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(payload) }] } } });
  });
  await page.route("**/api/engine/home/today", (route) => {
    readToday.push(route.request().method());
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
          observed_at: "2026-11-19T21:40:00Z",
          notes: ["Internal calendar instruction"],
          items:
            meetingState === "empty"
              ? []
              : [
                  {
                    title: "Example site visit",
                    start: "2026-11-19T16:00:00Z",
                    end: "2026-11-19T17:00:00Z",
                    context_label: "Example Dental",
                    attendees: [{ name: "Example Attendee" }],
                    open_url: "/deals?deal=example",
                  },
                ],
          follow_up_reviews: [],
        },
        reminders: {
          state: "ready",
          late: [
            {
              kind: "step",
              owner: "joe",
              title: "Send sample floor plan",
              due_on: "2026-11-16",
              days_late: 3,
              late_label: "3 days late",
              home_item_id: "example-reminder",
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
  const captureQueue = recentChanges
    ? page.waitForResponse(
        (response) =>
          response.url().endsWith("/mcp") && response.request().postDataJSON()?.params?.name === "capture-queue",
      )
    : null;
  const navigation = await page.goto(url.href, { waitUntil: "domcontentloaded" });
  await (await captureQueue)?.finished();
  assert.equal(navigation?.status(), 200);
  return { page, today: page.getByRole("complementary", { name: "Today", exact: true }), legacy, readToday };
}

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
    await page.locator("#docOpen").waitFor({ state: "attached" });
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

test("Doc keeps Morning brief with the switch off and drops it with the switch on", async (t) => {
  const off = await open(t, "/invoices", { enabled: false });
  await off.today.getByRole("heading", { name: "Your schedule", exact: true }).waitFor();
  assert.equal(await off.page.getByRole("button", { name: "Workspace sidebar", exact: true }).isVisible(), true);
  await off.page.getByRole("button", { name: "Open Doc", exact: true }).click();
  await off.page.getByRole("button", { name: "Morning brief", exact: true }).click();
  await off.page.getByRole("dialog", { name: /^Morning brief/ }).waitFor();
  assert.deepEqual([...new Set(off.legacy)].sort(), [...legacyVerbs].sort());
  assert.deepEqual(off.readToday, []);

  const on = await open(t, "/invoices");
  await on.today.getByText("Example site visit", { exact: true }).waitFor();
  await on.page.getByRole("button", { name: "Open Doc", exact: true }).click();
  await on.page.getByRole("dialog", { name: "Doc", exact: true }).waitFor();
  assert.equal(await on.page.getByRole("button", { name: "Morning brief", exact: true }).count(), 0);
  assert.equal(await on.page.locator("#docMorningBrief").count(), 0);
  assert.deepEqual(on.legacy, []);
});

for (const width of [390, 1440])
  for (const theme of ["light", "dark"]) {
    test(`Today shows meetings and last sync at ${width}px in ${theme}`, async (t) => {
      const { page, today } = await open(t, "/invoices", { width, theme, meetingState: "partial" });
      if (width === 390) await page.getByRole("button", { name: "Today sidebar", exact: true }).click();
      const meetings = today.getByRole("region", { name: "Meetings", exact: true });
      await meetings.getByText("Example site visit", { exact: true }).waitFor();
      assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
      assert.equal(await meetings.getByText(/Check Outlook|Internal calendar instruction/).count(), 0);
      await meetings.getByText("Last synced Nov 19, 3:40 PM CST.", { exact: true }).waitFor();
      const owners = today.getByRole("combobox", { name: "Reminders for" });
      await owners.selectOption("dell");
      await today.getByText("No dated reminders.", { exact: true }).waitFor();
      await owners.selectOption("all");
      await today.getByText("Send sample floor plan", { exact: true }).waitFor();
      if (process.env.PARTNER_MENU_SCREENSHOT_DIR) {
        await mkdir(process.env.PARTNER_MENU_SCREENSHOT_DIR, { recursive: true });
        await today.screenshot({ path: join(process.env.PARTNER_MENU_SCREENSHOT_DIR, `today-${width}-${theme}.png`) });
      }
    });
  }

test("Today says when the calendar is empty", async (t) => {
  const { today } = await open(t, "/invoices", { meetingState: "empty" });
  await today.getByText("No meetings today.", { exact: true }).waitFor();
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
      /10:00 AM CST/,
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
    await page.clock.runFor(120_000);
    const jump = page.getByRole("button", { name: /Go to recent changes/ });
    await jump.click({ timeout: 10000 });
    const receipts = page.getByRole("region", { name: "Recent changes", exact: true });
    await receipts.getByText(/Review sample terms/).waitFor();
    assert.equal(await page.locator("#receiptsTitle").evaluate((title) => title === document.activeElement), true);
    assert.equal(await receipts.evaluate((panel) => Boolean(panel.closest("#appMainSlot"))), true);
    assert.equal(await receipts.evaluate((panel) => panel.getBoundingClientRect().top < innerHeight), true);
  });
}
