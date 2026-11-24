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
const staleNote = "This calendar was last read from Outlook more than 18 hours ago.";

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
      notes: [staleNote],
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

async function routeApp(page: Page, origin: string, ranges: string[], answer: () => Response | object) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== app) return route.abort();
    if (url.pathname === datesRead) return route.fulfill({ json: dates });
    if (url.pathname === meetingsRead) {
      ranges.push(url.search);
      const reply = answer();
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
          assert.deepEqual(ranges, ["?from=2026-09-27&to=2026-11-07"]);
          await expect(page.locator("#calMeetingsNote")).toHaveText("Meetings show for about the next two weeks.");
          await expect(page.locator("#calNotices")).toHaveText(`Dell: ${staleNote}`);

          const panel = page.locator("#dayPanelBody");
          await expect(panel.locator(".cal-day-entry h3")).toHaveText(["Lease review", "Site walk", "LOI expiry"]);
          const review = panel.locator(".cal-day-entry").filter({ hasText: "Lease review" });
          await expect(review).toContainText("Meeting · Joe · 9:00 AM");
          await expect(review.getByRole("link", { name: "Example lease" })).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-1",
          );
          const walk = panel.locator(".cal-day-entry").filter({ hasText: "Site walk" });
          await expect(walk).toHaveText("Meeting · Dell · 2:30 PM Site walk");
          if (width === 390) {
            const height = await review.getByRole("link").evaluate((node) => node.getBoundingClientRect().height);
            assert.ok(height >= 44, `the deal link is a 44 px target (${height})`);
          }
          const comingUp = page.getByRole("region", { name: "Coming up" });
          await expect(
            comingUp.getByRole("button", { name: "Oct 21 11:30 PM Late dinner Joe", exact: true }),
          ).toBeVisible();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });

          await page.locator('[data-select-day="2026-10-21"]').click();
          await expect(panel).toHaveText("Meeting · Joe · 11:30 PM Late dinner");
          await page.locator('[data-select-day="2026-10-22"]').click();
          await expect(panel).toHaveText("No critical dates or next steps on this day.");
          await page.locator('[data-select-day="2026-10-23"]').click();
          await expect(panel.locator(".cal-day-entry")).toHaveText("Tour · Dell Tour · 3 stops Example expansion");
          await expect(panel.getByRole("link", { name: "Example expansion" })).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-2",
          );

          await page.getByRole("button", { name: "Week", exact: true }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date · 3 meetings · 1 tour");
          assert.deepEqual(ranges.at(-1), "?from=2026-10-18&to=2026-10-24");
          const chip = page.getByRole("button", { name: /^Meeting · 9:00 AM Lease review · Example lease/ });
          await expect(chip).toBeVisible();
          await expect(chip.locator(".cal-chip-label")).toHaveText("9:00 AM Lease review");
          await expect(page.getByRole("button", { name: /^Tour · Tour · 3 stops · Example expansion/ })).toBeVisible();
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `week-${width}-${theme}.png`), fullPage: true });

          answer = () => new Response("{}", { status: 503 });
          await page.getByRole("button", { name: "Month", exact: true }).click();
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calNotices")).toHaveText("Meetings could not be loaded. Refresh to try again.");
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await page.locator('[data-select-day="2026-11-12"]').click();
          await expect(panel.locator(".cal-day-entry h3")).toHaveText(["LOI expiry"]);

          answer = () => meetings;
          await page.locator("#calRefresh").click();
          await expect(page.locator("#calNotices")).toHaveText(`Dell: ${staleNote}`);

          answer = () => new Response("{}", { status: 404 });
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calMeetingsNote")).toBeHidden();
          await expect(page.locator("#calNotices")).toBeEmpty();
        } finally {
          await page.close();
        }
      });
    }
});
