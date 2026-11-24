import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { expect as baseExpect, type Locator, type Page } from "@playwright/test";
import { buildArtifact } from "../scripts/artifact.mjs";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium, WAIT_MS } from "./browser-harness.mjs";

const expect = baseExpect.configure({ timeout: WAIT_MS });
const root = fileURLToPath(new URL("../", import.meta.url));
const app = "https://doctorcre-app-staging.joe-bookout-carr-us.workers.dev";
const busyDays = [2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 22, 23, 26, 27, 29].map(
  (day) => `2026-10-${String(day).padStart(2, "0")}`,
);
const calendar = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [],
  next_steps: busyDays.flatMap((day) =>
    ["A", "B", "C"].map((letter) => ({
      id: `${day}-${letter}`,
      what: `Synthetic step ${letter} for ${day}`,
      owner: "dell",
      record_label: "Synthetic clinic",
      due_on: day,
      display_on: day,
      days_late: 0,
      open_url: "/relationships?node=party:synthetic-clinic",
    })),
  ),
};

const inViewport = (locator: Locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.bottom <= innerHeight;
  });

async function openCalendar(page: Page, server: { origin: string }, namespace: string, theme: string, query: string) {
  await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
    localStorage.setItem("doctorcre:today", "closed");
  }, theme);
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
    data: { namespace: `calendar-day-panel-${namespace}`, reset: true },
  });
  await page.goto(`${app}/calendar?${query}`);
  await expect(page.locator("#calAsOf")).toContainText("Updated");
}

test("The day panel opens where the partner is looking and closing it keeps focus on a visible day", async (t) => {
  const outDir = await temporaryDirectory("calendar-day-panel-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-day-panel");
  await mkdir(evidence, { recursive: true });

  const viewports = { 1440: { width: 1440, height: 900 }, 390: { width: 390, height: 844 } };
  for (const [width, viewport] of Object.entries(viewports))
    for (const theme of ["light", "dark"])
      await t.test(`${width} ${theme}`, async (t) => {
        const page = await browser.newPage({ viewport, reducedMotion: "reduce" });
        try {
          await openCalendar(page, server, `${width}-${theme}`, theme, "view=month&d=2026-10-01");
          const day = width === "1440" ? "2026-10-26" : "2026-10-02";
          const chip = page.locator(`#calGrid .cal-chip[data-day="${day}"]`).first();

          await t.test(`a chip on ${day} opens the panel in view`, async () => {
            if (width === "1440") await page.mouse.wheel(0, 600);
            await chip.click();
            const title = page.locator("#dayPanelTitle");
            await expect(title).toHaveText(/Oct 26|Oct 2,/);
            const entry = page.locator('#dayPanelBody .cal-day-entry[data-focus="true"]');
            await expect(entry).toHaveCount(1);
            await expect.poll(() => inViewport(title), { message: "the panel heading is on screen" }).toBe(true);
            await expect.poll(() => inViewport(entry), { message: "the clicked item is on screen" }).toBe(true);
            if (width === "1440")
              assert.equal(await inViewport(chip), true, "the month stays where the partner scrolled it");
            await page.screenshot({ path: join(evidence, `panel-${width}-${theme}.png`) });
          });

          await t.test("closing the panel returns focus to the day, and Tab moves on from it", async () => {
            await page.getByRole("button", { name: "Close day" }).click();
            const open = page.locator(`.cal-day-open[data-select-day="${day}"]`);
            await expect(open).toBeFocused();
            await expect(open).toHaveAttribute("tabindex", "0");
            await page.keyboard.press("Tab");
            await expect(chip).toBeFocused();
          });

          if (width === "390") {
            await t.test("closing an empty day on a phone moves focus to a day still shown", async () => {
              await page.goto(`${app}/calendar?view=month&d=2026-10-01&day=2026-10-21`);
              await expect(page.locator("#dayPanelTitle")).toContainText("Oct 21");
              await page.getByRole("button", { name: "Close day" }).click();
              const focused = page.locator(".cal-day-open:focus");
              await expect(focused).toBeVisible();
              await expect(focused).toHaveAttribute("data-select-day", "2026-10-20");
            });
            await t.test("an empty day in the phone week is one short row", async () => {
              await page.goto(`${app}/calendar?view=week&d=2026-10-18`);
              const empty = page.locator('#calGrid .cal-day[data-day="2026-10-18"]');
              await expect(empty).toBeVisible();
              const height = await empty.evaluate((node) => node.getBoundingClientRect().height);
              assert.ok(height < 100, `an empty week day is under 100 px (${height})`);
              await page.screenshot({ path: join(evidence, `week-${width}-${theme}.png`), fullPage: true });
            });
          }
        } finally {
          await page.close();
        }
      });
});
