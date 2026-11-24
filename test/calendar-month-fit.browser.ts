import assert from "node:assert/strict";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expect as baseExpect } from "@playwright/test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium, WAIT_MS } from "./browser-harness.mjs";

const expect = baseExpect.configure({ timeout: WAIT_MS });
const root = fileURLToPath(new URL("../", import.meta.url));
const app = "https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const step = (day: string, letter: string) => ({
  id: `${day}-${letter}`,
  what: `Synthetic step ${letter} for ${day}`,
  owner: "dell",
  record_label: "Synthetic clinic",
  due_on: day,
  display_on: day,
  days_late: 0,
  open_url: "/relationships?node=party:synthetic-clinic",
});
// Oct 29 sits in the last of October's six week rows and holds more items than any cell shows.
const fullDay = "2026-10-29";
const fullDayItems = 13;
const calendar = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [],
  next_steps: [
    ...[5, 6, 7, 8, 9, 12, 13, 14].flatMap((day) =>
      ["A", "B", "C"].map((letter) => step(`2026-10-${String(day).padStart(2, "0")}`, letter)),
    ),
    ..."ABCDEFGHIJKLM".split("").map((letter) => step(fullDay, letter)),
  ],
};

test("The whole month fits on one screen, with or without the day sheet beside it", async (t) => {
  const outDir = await temporaryDirectory("calendar-month-fit-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [1920, 1080],
  ] as const)
    for (const sheet of [false, true])
      await t.test(`${width}x${height}${sheet ? " with the day sheet open" : ""}`, async () => {
        const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
        try {
          await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
          await page.addInitScript(() => localStorage.setItem("doctorcre:today", "closed"));
          await page.route("**/*", async (route) => {
            const request = route.request();
            const url = new URL(request.url());
            if (url.origin !== app) return route.abort();
            if (url.pathname === "/api/engine/calendar/critical-dates") return route.fulfill({ json: calendar });
            const response = await page.request.fetch(`${server.origin}${url.pathname}${url.search}`, {
              method: request.method(),
              data: request.postData() ?? undefined,
              headers: { "content-type": "application/json" },
            });
            return route.fulfill({ response });
          });
          await page.request.post(`${server.origin}/api/test/seed`, {
            data: { namespace: `calendar-month-fit-${width}-${sheet}`, reset: true },
          });
          await page.goto(`${app}/calendar?view=month&d=2026-10-01${sheet ? `&day=${fullDay}` : ""}`);
          await expect(page.locator("#calAsOf")).toContainText("Updated");
          await expect(page.locator("#dayPanel")).toBeVisible({ visible: sheet });
          const weeks = page.locator("#calGrid .cal-week:has(.cal-day)");
          await expect(weeks).toHaveCount(6);

          const fit = () =>
            page.evaluate(() => ({
              lastWeekBottom:
                document.querySelector("#calGrid .cal-week:last-child")?.getBoundingClientRect().bottom ??
                Number.POSITIVE_INFINITY,
              pageHeight: document.documentElement.scrollHeight,
            }));
          await expect
            .poll(async () => (await fit()).lastWeekBottom, { message: "the last week row ends on screen" })
            .toBeLessThanOrEqual(height);
          assert.ok((await fit()).pageHeight <= height, `the page does not scroll: ${JSON.stringify(await fit())}`);

          const full = page.locator(`#calGrid .cal-day[data-day="${fullDay}"]`);
          const more = full.locator(".cal-more");
          await expect(more).toHaveText(/^\+\d+ more$/);
          const shown = await full.evaluate((cell) => {
            const box = cell.getBoundingClientRect();
            const inside = (node: Element) => {
              const part = node.getBoundingClientRect();
              return part.top >= box.top && part.bottom <= box.bottom;
            };
            const chips = [...cell.querySelectorAll(".cal-chip")].filter((chip) => chip.checkVisibility());
            return {
              chips: chips.length,
              clipped: chips.filter((chip) => !inside(chip)).length,
              moreInside: [...cell.querySelectorAll(".cal-more")].some(inside),
            };
          });
          assert.ok(shown.chips >= 1, "a full day shows at least one chip");
          assert.equal(shown.clipped, 0, "no chip is cut off");
          assert.ok(shown.moreInside, "+N more sits inside the day");
          await expect(more).toHaveText(`+${fullDayItems - shown.chips} more`);
        } finally {
          await page.close();
        }
      });
});
