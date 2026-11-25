import assert from "node:assert/strict";
import { mkdir, rm } from "node:fs/promises";
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
const today = "2026-10-20";
const dealUrl = "/deals?deal=qa-deal-1&focus=next-step&step=late-estoppel";
const vendorUrl = "/relationships?node=party:synthetic-vendor";

const step = (id: string, due_on: string, what: string, days_late = 0, open_url = vendorUrl) => ({
  id,
  what,
  why: null,
  owner: "dell",
  record_label: "Synthetic vendor",
  due_on,
  display_on: due_on < today ? today : due_on,
  days_late,
  open_url,
});
const calendar = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [
    {
      id: "d-1",
      deal_id: "qa-deal-1",
      deal_name: "Synthetic lease",
      kind: "LOI expiry",
      owner: "joe",
      due_on: "2026-10-27",
      done: false,
    },
  ],
  next_steps: [
    {
      ...step("late-estoppel", "2026-10-06", "Send the synthetic estoppel", 14, dealUrl),
      record_label: "Synthetic lease",
    },
    step("late-landlord", "2026-10-15", "Call the synthetic landlord", 5),
    step("soon", "2026-10-23", "Confirm the synthetic suite plan"),
    step("outside", "2026-11-05", "Synthetic step past two weeks"),
    step("far", "2026-12-30", "Check in with Sam (vendor)"),
  ],
};

test("Calendar puts each dated item on its own day, keeps late steps in one chip on today and limits Coming up to two weeks", async (t) => {
  const outDir = await temporaryDirectory("calendar-dated-days-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-dated-days");
  await mkdir(evidence, { recursive: true });

  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
  ] as const)
    await t.test(`${width}x${height}`, async (t) => {
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
          data: { namespace: `calendar-dated-days-${width}`, reset: true },
        });
        await page.goto(`${app}/calendar?view=month&d=2026-10-01`);
        await expect(page.locator("#calAsOf")).toContainText("Updated");
        const grid = page.locator("#calGrid");
        const cell = (day: string) => grid.locator(`.cal-day[data-day="${day}"]`);

        await t.test("each late step also sits on its own due day", async () => {
          const estoppel = cell("2026-10-06").getByRole("button", { name: /Send the synthetic estoppel/ });
          await expect(estoppel).toBeVisible();
          await expect(estoppel).toHaveAttribute("data-band", "overdue");
          await expect(cell("2026-10-15").getByRole("button", { name: /Call the synthetic landlord/ })).toBeVisible();
          await expect(
            cell("2026-10-23").getByRole("button", { name: /Confirm the synthetic suite plan/ }),
          ).toBeVisible();
          await expect(page.locator("#calCount")).toHaveText("3 next steps · 1 critical date");
        });

        await t.test("today holds one compact late chip and no late step of its own", async () => {
          const chips = cell(today).locator(".cal-chip");
          await expect(chips).toHaveCount(1);
          await expect(chips).toHaveText("2 late");
          await expect(chips).toHaveAccessibleName("2 late steps");
        });

        await t.test("the whole month fits one screen", async () => {
          const fit = await page.evaluate(() => ({
            lastWeekBottom:
              document.querySelector("#calGrid .cal-week:last-child")?.getBoundingClientRect().bottom ?? 0,
            pageHeight: document.documentElement.scrollHeight,
          }));
          assert.ok(fit.lastWeekBottom <= height && fit.pageHeight <= height, JSON.stringify(fit));
        });
        await page.screenshot({ path: join(evidence, `month-${width}.png`) });

        await t.test("the late chip lists the late steps, each opening its record", async () => {
          await cell(today).getByRole("button", { name: "2 late steps" }).click();
          const late = page.locator("#dayPanelBody").getByRole("region", { name: "Late" });
          await expect(late.locator(".cal-day-entry")).toHaveCount(2);
          await expect(late.getByRole("link", { name: "Synthetic lease" })).toHaveAttribute("href", dealUrl);
          await expect(late.getByRole("link", { name: "Synthetic vendor" })).toHaveAttribute("href", vendorUrl);
          await page.screenshot({ path: join(evidence, `late-${width}.png`) });
          await late.getByRole("link", { name: "Synthetic vendor" }).click();
          await page.waitForURL((url) => url.pathname === "/relationships");
          await page.goBack();
          await expect(page.locator("#calAsOf")).toContainText("Updated");
        });

        await t.test("Coming up lists only the next 14 days", async () => {
          await page.goto(`${app}/calendar?view=week&d=${today}`);
          const comingUp = page.getByRole("region", { name: "Coming up" });
          await expect(comingUp.locator(".cal-agenda-item time")).toHaveText(["Oct 23", "Oct 27"]);
          await expect(comingUp).not.toContainText("Check in with Sam");
          await page.screenshot({ path: join(evidence, `week-${width}.png`) });
        });

        await t.test("Day view of today still shows the late chip in its band", async () => {
          await page.getByRole("button", { name: "Today", exact: true }).click();
          await expect(page.locator("#calPeriod")).toHaveText("Tuesday, Oct 20, 2026");
          await expect(grid.locator(".cal-chips .cal-chip")).toHaveText(["2 late"]);
        });
      } finally {
        await page.close();
      }
    });
});
