import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
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

// Oct 20 is CDT, five hours behind UTC.
const utc = (day: number, hour: number, minute = 0) =>
  new Date(Date.UTC(2026, 9, day, hour, minute)).toISOString().replace(".000", "");
const dates = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [
    {
      id: "d1",
      deal_id: "qa-deal-1",
      deal_name: "Example lease",
      kind: "LOI expiry",
      owner: "joe",
      due_on: "2026-10-20",
      done: false,
    },
  ],
  next_steps: [
    {
      id: "s1",
      what: "Send the synthetic proposal",
      owner: "dell",
      record_label: "Example clinic",
      due_on: "2026-10-20",
      display_on: "2026-10-20",
      days_late: 0,
      open_url: null,
    },
  ],
};
const meeting = (title: string, day: number, [hour, minute]: [number, number], length: number) => ({
  title,
  start: utc(day, hour, minute),
  end: utc(day, hour, minute + length),
});
const meetings = {
  ok: true,
  schema_version: "calendar-meetings.v1",
  meetings: [
    {
      partner: "joe",
      name: "Example Partner One",
      state: "ready",
      reason: null,
      notes: [],
      items: [
        meeting("Short call", 20, [14, 0], 30),
        meeting("Lease review", 20, [15, 0], 60),
        meeting("Lender call", 20, [15, 30], 60),
        meeting("Tomorrow sync", 21, [14, 0], 60),
      ],
    },
  ],
  tours: {
    state: "ready",
    reason: null,
    items: [
      {
        id: "t1",
        deal_id: "qa-deal-2",
        deal_name: "Example expansion",
        owner: "dell",
        planned_on: "2026-10-20",
        stop_count: 2,
      },
    ],
  },
};

async function route(page: Page, origin: string, answers: Record<string, object>) {
  await page.route("**/*", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== app) return route.abort();
    if (answers[url.pathname]) return route.fulfill({ json: answers[url.pathname] });
    const response = await page.request.fetch(`${origin}${url.pathname}${url.search}`, {
      method: request.method(),
      data: request.postData() ?? undefined,
      headers: { "content-type": "application/json" },
    });
    return route.fulfill({ response });
  });
}

const box = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => {
    const rect = node.getBoundingClientRect();
    return { top: rect.top, left: rect.left, width: rect.width, height: rect.height };
  });

test("Today opens a one-day timeline that fits the screen", async (t) => {
  const outDir = await temporaryDirectory("calendar-day-view-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [390, 844],
  ] as const)
    await t.test(`${width}x${height}`, async () => {
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      try {
        await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
        await page.addInitScript(() => localStorage.setItem("doctorcre:today", "closed"));
        await route(page, server.origin, {
          "/api/engine/calendar/critical-dates": dates,
          "/api/engine/calendar/meetings": meetings,
        });
        await page.request.post(`${server.origin}/api/test/seed`, {
          data: { namespace: `calendar-day-view-${width}`, reset: true },
        });
        await page.goto(`${app}/calendar?view=month&d=2026-09-01`);
        await expect(page.locator("#calAsOf")).toContainText("Updated");

        await page.getByRole("button", { name: "Today", exact: true }).click();
        await expect(page).toHaveURL(/\/calendar\?view=day&d=2026-10-20$/);
        await expect(page.getByRole("button", { name: "Day", exact: true })).toHaveAttribute("aria-pressed", "true");
        await expect(page.locator("#calPeriod")).toHaveText("Tuesday, Oct 20, 2026");
        await expect(page.locator(".cal-day-open")).toBeFocused();

        const band = page.locator(".cal-day > .cal-chips");
        const blocks = page.locator(".cal-blocks");
        for (const name of ["Send the synthetic proposal", "LOI expiry", "2 stops"]) {
          await expect(band).toContainText(name);
          await expect(blocks).not.toContainText(name);
        }
        await expect(blocks.locator("li")).toHaveCount(3);

        const nine = await box(page, '.cal-hours [data-hour="9"]');
        const short = await box(page, '.cal-blocks li:has([title*="Short call"])');
        assert.ok(
          Math.abs(short.top - nine.top) <= 1,
          `a 9:00 meeting starts on the 9 AM line: ${short.top} vs ${nine.top}`,
        );
        assert.ok(
          Math.abs(short.height - nine.height / 2) <= 1,
          `a 30-minute meeting is half an hour tall: ${short.height}`,
        );
        const shortChip = await box(page, '.cal-blocks [title*="Short call"]');
        assert.ok(
          Math.abs(shortChip.height - (short.height - 2)) <= 1,
          `a 30-minute meeting's chip fills its half hour: ${shortChip.height} in ${short.height}`,
        );
        if (width < 760) assert.ok(shortChip.height >= 44, `a phone chip is a 44px tap target: ${shortChip.height}`);
        const lane = await box(page, ".cal-blocks");
        const review = await box(page, '.cal-blocks li:has([title*="Lease review"])');
        const lender = await box(page, '.cal-blocks li:has([title*="Lender call"])');
        assert.ok(Math.abs(short.width - lane.width) <= 1, "a meeting with no overlap takes the full width");
        for (const half of [review, lender])
          assert.ok(Math.abs(half.width - lane.width / 2) <= 1, "overlapping meetings share the width");
        assert.ok(Math.abs(lender.left - review.left - lane.width / 2) <= 1, "overlapping meetings sit side by side");
        assert.ok(
          Math.abs(lender.top - review.top - nine.height / 2) <= 1,
          "the 10:30 meeting starts half an hour below 10:00",
        );

        const timeline = await box(page, ".cal-timeline");
        const now = await box(page, ".cal-now");
        assert.ok(now.top >= timeline.top && now.top <= timeline.top + timeline.height, "the now-line is on screen");
        const ten = await box(page, '.cal-hours [data-hour="10"]');
        assert.ok(Math.abs(now.top - ten.top) <= 2, `the now-line sits at 10:00 AM Central: ${now.top} vs ${ten.top}`);
        const page_ = await page.evaluate(() => ({
          height: document.documentElement.scrollHeight,
          width: document.documentElement.scrollWidth,
        }));
        assert.ok(page_.height <= height && page_.width <= width, `the page does not scroll: ${JSON.stringify(page_)}`);

        await page.locator('.cal-blocks [title*="Lease review"]').click();
        await expect(page.locator("#dayPanel")).toBeVisible();
        await expect(page.locator('#dayPanelBody [data-focus="true"] h3')).toHaveText("Lease review");
        await page.keyboard.press("Escape");
        await expect(page.locator("#dayPanel")).toBeHidden();

        await page.getByRole("button", { name: "Next day" }).click();
        await expect(page.locator("#calPeriod")).toHaveText("Wednesday, Oct 21, 2026");
        await expect(page).toHaveURL(/view=day&d=2026-10-21$/);
        await expect(blocks).toContainText("Tomorrow sync");
        await page.getByRole("button", { name: "Previous day" }).click();
        await expect(page.locator("#calPeriod")).toHaveText("Tuesday, Oct 20, 2026");
        await page.locator(".cal-day-open").focus();
        await page.keyboard.press("ArrowDown");
        await expect(page.locator('.cal-day-open[data-select-day="2026-10-21"]')).toBeFocused();
        await page.keyboard.press("ArrowUp");
        await expect(page.locator('.cal-day-open[data-select-day="2026-10-20"]')).toBeFocused();
        await page.keyboard.press("ArrowRight");
        await expect(page.locator('.cal-day-open[data-select-day="2026-10-21"]')).toBeFocused();
        await page.goBack();
        await expect(page.locator("#calPeriod")).toHaveText("Tuesday, Oct 20, 2026");
      } finally {
        await page.close();
      }
    });
});

test("A meeting's name fills its block, and a resize refits it", async (t) => {
  const outDir = await temporaryDirectory("calendar-day-names-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const long = "Quarterly planning with the lender, the landlord's broker and both partners about the second building";
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await page.clock.install({ time: new Date("2026-10-22T13:00:00Z") });
  await page.addInitScript(() => localStorage.setItem("doctorcre:today", "closed"));
  await route(page, server.origin, {
    "/api/engine/calendar/critical-dates": { ...dates, critical_dates: [], next_steps: [] },
    "/api/engine/calendar/meetings": {
      ...meetings,
      meetings: [
        { ...meetings.meetings[0], items: [meeting(long, 22, [14, 0], 60), meeting("Quick call", 22, [16, 0], 15)] },
      ],
    },
  });
  await page.request.post(`${server.origin}/api/test/seed`, { data: { namespace: "calendar-day-names", reset: true } });
  await page.goto(`${app}/calendar?view=day&d=2026-10-22`);
  await expect(page.locator("#calAsOf")).toContainText("Updated");

  const nine = await box(page, '.cal-hours [data-hour="9"]');
  const quick = await box(page, '.cal-blocks li:has([title*="Quick call"])');
  assert.ok(
    Math.abs(quick.height - nine.height / 2) <= 1,
    `a 15-minute meeting takes half an hour so its name fits: ${quick.height}`,
  );

  const fit = () =>
    page.locator('.cal-blocks [title*="Quarterly planning"] .cal-chip-label').evaluate((label) => {
      const block = label.parentElement;
      if (!block) return "no block";
      const chip = getComputedStyle(block);
      const line = Number.parseFloat(getComputedStyle(label).lineHeight);
      const inner = block.clientHeight - Number.parseFloat(chip.paddingTop) - Number.parseFloat(chip.paddingBottom);
      const room = Math.floor(inner / line);
      const shown = Math.round(label.getBoundingClientRect().height / line);
      return shown === Math.min(room, Math.round(label.scrollHeight / line)) ? "fits" : `${shown} of ${room} lines`;
    });
  expect(await fit()).toBe("fits");
  await page.setViewportSize({ width: 390, height: 844 });
  await expect.poll(fit, { message: "a phone's taller hour shows more of the name" }).toBe("fits");
  await page.setViewportSize({ width: 1280, height: 640 });
  await expect.poll(fit, { message: "back on a computer the name ends on its block's last line" }).toBe("fits");
});
