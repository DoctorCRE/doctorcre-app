import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expect as baseExpect, type Page } from "@playwright/test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium, WAIT_MS } from "./browser-harness.mjs";

const expect = baseExpect.configure({ timeout: WAIT_MS });
const root = fileURLToPath(new URL("../", import.meta.url));
const app = "https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const datesRead = "/api/engine/calendar/critical-dates";
const meetingsRead = "/api/engine/calendar/meetings";
const engineStaleNote = "This calendar was last read from Outlook more than 18 hours ago.";

const dates = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [
    ["a", "2026-10-20"],
    ["b", "2026-11-12"],
  ].map(([id, due_on]) => ({
    id,
    deal_id: "qa-deal-1",
    deal_name: "Example lease",
    kind: "LOI expiry",
    owner: "joe",
    due_on,
    done: false,
  })),
  next_steps: [],
};

const meetings = {
  ok: true,
  schema_version: "calendar-meetings.v1",
  meetings: [
    {
      partner: "dell",
      name: "Example Partner Two",
      state: "partial",
      reason: null,
      observed_at: "2026-10-19T14:00:00Z",
      notes: [engineStaleNote],
      items: [{ title: "Site walk", start: "2026-10-20T19:30:00Z", end: "2026-10-20T20:30:00Z" }],
    },
    {
      partner: "joe",
      name: "Example Partner One",
      state: "ready",
      reason: null,
      notes: [],
      items: [
        {
          title: "Lease review",
          start: "2026-10-20T14:00:00Z",
          end: "2026-10-20T15:00:00Z",
          open_url: "/deals?deal=qa-deal-1",
          context_label: "Example lease",
        },
        // 11:30 PM Central on Oct 21 is already Oct 22 in UTC.
        { title: "Late dinner", start: "2026-10-22T04:30:00Z", end: "2026-10-22T05:30:00Z" },
      ],
    },
  ],
  tours: {
    state: "ready",
    reason: null,
    items: [
      {
        id: "tour-1",
        deal_id: "qa-deal-2",
        deal_name: "Example expansion",
        owner: "dell",
        planned_on: "2026-10-23",
        stop_count: 3,
        open_url: "/deals?deal=qa-deal-2",
      },
    ],
  },
};

type Reply = () => Response | object;

async function routeApp(page: Page, origin: string, ranges: string[], answer: Reply, datesAnswer: Reply = () => dates) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== app) return route.abort();
    const read = url.pathname === datesRead ? datesAnswer : url.pathname === meetingsRead ? answer : null;
    if (read) {
      if (read === answer) ranges.push(url.search);
      const reply = read();
      return reply instanceof Response
        ? route.fulfill({ status: reply.status, body: await reply.text() })
        : route.fulfill({ json: reply });
    }
    const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method(),
      data: request.postData() ?? undefined,
      headers: { "content-type": "application/json" },
    });
    return route.fulfill({ response });
  });
}

test("Calendar shows both partners' meetings and tours on their Central day with times", async (t) => {
  const outDir = await temporaryDirectory("calendar-meetings-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-meetings");
  await mkdir(evidence, { recursive: true });

  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      await t.test(`${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
        await page.addInitScript((theme) => {
          localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
          localStorage.setItem("doctorcre:today", "closed");
        }, theme);
        const ranges: string[] = [];
        let answer: () => Response | object = () => meetings;
        await routeApp(page, server.origin, ranges, () => answer());
        try {
          await page.request.post(`${server.origin}/api/test/seed`, {
            data: { namespace: `calendar-meetings-${width}-${theme}`, reset: true },
          });
          await page.goto(`${app}/calendar?view=month&d=2026-10-01&day=2026-10-20`);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#calCount")).toHaveText("1 critical date · 3 meetings · 1 tour");
          assert.deepEqual(ranges, ["?from=2026-09-27&to=2026-10-31"]);
          await expect(page.locator("main")).not.toContainText("two weeks");
          await expect(page.locator("body")).not.toContainText(/\b(CST|CDT)\b/);
          // A partner's Outlook sync state is for whoever runs the system, never a partner screen.
          await expect(page.locator("#calNotices")).toBeEmpty();

          const panel = page.locator("#dayPanelBody");
          await expect(panel.locator(".cal-day-entry h3")).toHaveText(["Lease review", "Site walk", "LOI expiry"]);
          const review = panel.locator(".cal-day-entry").filter({ hasText: "Lease review" });
          await expect(review.locator("small")).toHaveText("Meeting · Joe");
          await expect(review.locator(".cal-entry-when")).toHaveText("9:00 AM");
          await expect(review.locator(".cal-entry-for")).toHaveText("Example lease");
          await expect(review.getByRole("link", { name: "Example lease" })).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-1",
          );
          const walk = panel.locator(".cal-day-entry").filter({ hasText: "Site walk" });
          await expect(walk).toHaveText("Meeting · Dell Site walk 2:30 PM");
          if (width === 390) {
            const height = await review.getByRole("link").evaluate((node) => node.getBoundingClientRect().height);
            assert.ok(height >= 44, `the deal link is a 44 px target (${height})`);
          }
          // A wide month shows every day, so only the phone keeps Coming up.
          if (width === 390) {
            const comingUp = page.getByRole("region", { name: "Coming up" });
            await expect(
              comingUp.getByRole("button", { name: "Oct 21 11:30 PM Late dinner Joe", exact: true }),
            ).toBeVisible();
          }
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });

          // A phone's day sheet is modal, so a partner closes it before tapping another day.
          const closeOnPhone = async () => {
            if (width === 390) await page.getByRole("button", { name: "Close day" }).click();
          };
          const openDay = async (day: string) => {
            await closeOnPhone();
            await page.locator(`[data-select-day="${day}"]`).click();
          };
          await openDay("2026-10-21");
          await expect(panel).toHaveText("Meeting · Joe Late dinner 11:30 PM");
          if (width === 390) {
            await expect(
              page.locator('#calGrid .cal-day[data-day="2026-10-22"]'),
              "the phone agenda skips an empty day",
            ).toBeHidden();
          } else {
            const empty = page.locator('#calGrid .cal-day[data-day="2026-10-22"]');
            const box = await empty.boundingBox();
            assert.ok(box, "the empty day is on screen");
            await empty.click({ position: { x: box.width / 2, y: box.height - 8 } });
            await expect(panel).toHaveText("No events scheduled.");
            await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 22/);
          }
          await openDay("2026-10-23");
          await expect(panel.locator(".cal-day-entry")).toHaveText("Tour · Dell 3 stops Deal Example expansion");
          await expect(panel.getByRole("link", { name: "Example expansion" })).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-2",
          );

          await closeOnPhone();
          await page.getByRole("button", { name: "Week", exact: true }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date · 3 meetings · 1 tour");
          assert.deepEqual(ranges.at(-1), "?from=2026-10-18&to=2026-10-24");
          const chip = page.getByRole("button", { name: /^Meeting · 9:00 AM Lease review · Example lease/ });
          await expect(chip).toBeVisible();
          await expect(chip.locator(".cal-chip-label")).toHaveText("9:00 AM Lease review");
          await expect(
            page.getByRole("button", { name: /^Tour · 3 stops · Deal Example expansion · Dell/ }),
          ).toBeVisible();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `week-${width}-${theme}.png`), fullPage: true });

          answer = () => new Response("{}", { status: 503 });
          await page.getByRole("button", { name: "Month", exact: true }).click();
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calNotices")).toHaveText("Meetings could not be loaded. Refresh to try again.");
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await page.locator('[data-select-day="2026-11-12"]').click();
          await expect(panel.locator(".cal-day-entry h3")).toHaveText(["LOI expiry"]);
          await closeOnPhone();

          answer = () => ({
            ...meetings,
            meetings: [
              {
                ...meetings.meetings[0],
                state: "unavailable",
                reason: "No calendar snapshot has been synced from Outlook yet.",
                items: [],
              },
              meetings.meetings[1],
            ],
          });
          await page.locator("#calRefresh").click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await expect(page.locator("#calNotices")).toBeEmpty();
          await expect(page.locator("main")).not.toContainText("snapshot");

          answer = () => new Response("{}", { status: 404 });
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calNotices")).toBeEmpty();
        } finally {
          await page.close();
        }
      });
    }
});

const standingNotes = [
  "May include meetings you declined or that were cancelled or deleted. Check Outlook.",
  "Invites sent only to a group you belong to are not shown.",
];
const sharedMeeting = {
  key: "0123456789abcdef",
  title: "Joint  call",
  start: "2026-10-20T16:00:00Z",
  end: "2026-10-20T17:00:00Z",
};
const sharedMeetings = {
  ok: true,
  schema_version: "calendar-meetings.v1",
  meetings: [
    {
      partner: "dell",
      name: "Example Partner Two",
      state: "partial",
      reason: null,
      notes: standingNotes,
      meetings_may_be_missing: true,
      items: [
        {
          ...sharedMeeting,
          context_label: "Example lease, Example expansion",
          open_url: null,
          possible_deals: [
            { id: "qa-deal-1", name: "Example lease", open_url: "/deals?deal=qa-deal-1" },
            { id: "qa-deal-2", name: "Example expansion", open_url: "/deals?deal=qa-deal-2" },
          ],
        },
      ],
    },
    {
      partner: "joe",
      name: "Example Partner One",
      state: "partial",
      reason: null,
      notes: standingNotes,
      meetings_may_be_missing: false,
      items: [{ ...sharedMeeting, title: "Joint call" }],
    },
  ],
  tours: { state: "empty", reason: null, items: [] },
};

test("A meeting both partners attend shows once, sync notes stay quiet, and Refresh retries a failed read", async (t) => {
  const outDir = await temporaryDirectory("calendar-meetings-shared-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await page.clock.install({ time: new Date("2026-10-21T15:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("doctorcre:today", "closed"));
  const ranges: string[] = [];
  const failed = () => new Response("{}", { status: 503 });
  let answer: Reply = failed;
  let datesAnswer: Reply = failed;
  await routeApp(
    page,
    server.origin,
    ranges,
    () => answer(),
    () => datesAnswer(),
  );
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "calendar-meetings-shared", reset: true },
  });

  await page.goto(`${app}/calendar?view=week&d=2026-10-18&day=2026-10-20`);
  await expect(page.locator("#calNotices")).toContainText("Meetings could not be loaded. Refresh to try again.");
  const opened = ranges.length;

  answer = () => sharedMeetings;
  datesAnswer = () => dates;
  await page.locator("#calRefresh").click();
  await expect(page.locator("#calCount")).toHaveText("1 critical date · 1 meeting");
  assert.equal(ranges.length, opened + 1, "Refresh reads the meetings again");
  await expect(page.locator("#calNotices")).toBeEmpty();

  const panel = page.locator("#dayPanelBody");
  const joint = panel.locator(".cal-day-entry").filter({ hasText: "Joint call" });
  await expect(joint).toHaveCount(1);
  await expect(joint).toHaveText("Meeting · Dell and Joe Joint call Deals Example lease, Example expansion 11:00 AM");
  await expect(joint.getByRole("link", { name: "Example lease" })).toHaveAttribute("href", "/deals?deal=qa-deal-1");
  await expect(joint.getByRole("link", { name: "Example expansion" })).toHaveAttribute("href", "/deals?deal=qa-deal-2");
  await expect(page.locator('.cal-chip[data-entry="meeting:0123456789abcdef"]')).toHaveAttribute(
    "data-band",
    "settled",
  );
});

test("November meetings show Central standard time, all-day meetings say so, and a failed refresh keeps them", async (t) => {
  const outDir = await temporaryDirectory("calendar-meetings-november-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await page.clock.install({ time: new Date("2026-11-09T15:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("doctorcre:today", "closed"));
  const november = {
    ok: true,
    schema_version: "calendar-meetings.v1",
    meetings: [
      {
        partner: "joe",
        name: "Example Partner One",
        state: "ready",
        reason: null,
        observed_at: "2026-11-09T14:00:00Z",
        notes: [],
        items: [
          { title: "Budget call", start: "2026-11-10T15:00:00Z", end: "2026-11-10T16:00:00Z" },
          { title: "Office closed", start: "2026-11-11T06:00:00Z", end: "2026-11-12T06:00:00Z", all_day: true },
        ],
      },
    ],
    tours: { state: "empty", reason: null, items: [] },
  };
  const ranges: string[] = [];
  let answer: Reply = () => november;
  await routeApp(page, server.origin, ranges, () => answer());
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "calendar-meetings-november", reset: true },
  });

  await page.goto(`${app}/calendar?view=week&d=2026-11-08&day=2026-11-10`);
  await expect(page.locator("#calCount")).toHaveText("1 critical date · 2 meetings");
  const panel = page.locator("#dayPanelBody");
  await expect(panel).toHaveText("Meeting · Joe Budget call 9:00 AM");
  await page.locator('[data-select-day="2026-11-11"]').click();
  await expect(panel).toHaveText("Meeting · Joe Office closed All day");

  answer = () => new Response("{}", { status: 503 });
  await page.locator("#calRefresh").click();
  await expect(page.locator("#calNotices")).toHaveText("Calendar could not refresh. Try again.Retry");
  await expect(page.locator("#calCount")).toHaveText("1 critical date · 2 meetings");
  await expect(panel).toHaveText("Meeting · Joe Office closed All day");
  await expect(page.getByRole("button", { name: /^Meeting · 9:00 AM Budget call/ })).toBeVisible();

  answer = () => november;
  await page.getByRole("button", { name: "Retry" }).click();
  await expect(page.locator("#calNotices")).toBeEmpty();
  assert.equal(ranges.length, 3, "Refresh and Retry each read the meetings again");
});
