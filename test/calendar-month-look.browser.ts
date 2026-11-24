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
const busyDay = "2026-10-14";
const longTitle =
  "Confirm the signed estoppel and the final suite plan with every synthetic party before the walkthrough";

const step = (id: string, day: string, what: string) => ({
  id,
  what,
  owner: "dell",
  record_label: "Synthetic clinic",
  due_on: day,
  display_on: day,
  days_late: 0,
  open_url: "/relationships?node=party:synthetic-clinic",
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
      due_on: busyDay,
      done: false,
    },
    {
      id: "d-2",
      deal_id: "qa-deal-1",
      deal_name: "Synthetic lease",
      kind: "Option notice",
      owner: "joe",
      due_on: "2026-10-27",
      done: false,
    },
  ],
  next_steps: [
    ...["A", "B", "C", "D", "E"].map((letter) => step(`s-${letter}`, busyDay, `Synthetic step ${letter}`)),
    step("s-long", "2026-10-22", longTitle),
  ],
};

test("Calendar month grid marks today, colors chips by kind, folds overflow and turns into an agenda on a phone", async (t) => {
  const outDir = await temporaryDirectory("calendar-month-look-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-month-look");
  await mkdir(evidence, { recursive: true });

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await t.test(`${width} ${theme}`, async (t) => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        // 10 pm Central on Oct 20 is already Oct 21 in UTC; today stays the 20th.
        await page.clock.install({ time: new Date("2026-10-21T03:00:00Z") });
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
        try {
          await page.request.post(`${server.origin}/api/test/seed`, {
            data: { namespace: `calendar-month-look-${width}-${theme}`, reset: true },
          });
          await page.goto(`${app}/calendar?view=month&d=2026-10-01`);
          await expect(page.locator("#calAsOf")).toContainText("Updated");
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#calPeriod")).toHaveText("October 2026");
          for (const name of ["Previous month", "Next month", "Month", "Week"])
            await expect(page.getByRole("button", { name, exact: true })).toBeVisible();
          await expect(page.locator("#calToday")).toHaveText("Today");

          const grid = page.locator("#calGrid");
          const today = grid.locator('.cal-day[data-today="true"]');
          await expect(today).toHaveAttribute("data-day", "2026-10-20");
          const accent = await page.evaluate(() => {
            const probe = document.body.appendChild(document.createElement("i"));
            probe.style.color = "var(--accent)";
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          });
          await expect(today.locator(".cal-day-num")).toHaveCSS("background-color", accent);
          await expect(today.locator(".cal-day-num")).toHaveCSS("border-radius", /\d{3,}px|50%/);

          const busy = grid.locator(`.cal-day[data-day="${busyDay}"]`);
          const chips = busy.locator(".cal-chip");
          const step = busy.locator('.cal-chip[data-kind="step"]').first();
          const date = busy.locator('.cal-chip[data-kind="date"]');
          const tint = (locator: typeof step) => locator.evaluate((node) => getComputedStyle(node).backgroundColor);
          assert.notEqual(await tint(step), await tint(date), "a next step and a critical date have different tints");
          await expect(chips).toHaveCount(6);

          const long = grid.getByRole("button", { name: new RegExp(longTitle) });
          const line = await long.locator(".cal-chip-label").evaluate((node) => ({
            height: node.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
          }));
          assert.ok(line.height <= line.lineHeight + 1, "a long title stays on one line");
          await expect(long).toHaveAttribute("title", longTitle);

          if (width === 1440) {
            await t.test("the grid has Sun-Sat headers, six weeks and muted outside days", async () => {
              await expect(grid.getByRole("columnheader")).toHaveText([
                "Sun",
                "Mon",
                "Tue",
                "Wed",
                "Thu",
                "Fri",
                "Sat",
              ]);
              await expect(grid.locator(".cal-day")).toHaveCount(42);
              const outside = grid.locator('.cal-day[data-out-month="true"]').first();
              await expect(outside).toBeVisible();
              assert.notEqual(await tint(outside), await tint(grid.locator('.cal-day[data-day="2026-10-13"]')));
            });
            await t.test("a full day shows three chips and opens the rest from +N more", async () => {
              await expect(chips.filter({ visible: true })).toHaveCount(3);
              const more = busy.getByRole("button", { name: /^3 more on/ });
              await expect(more).toHaveText("+3 more");
              await more.click();
              await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(6);
            });
          } else {
            await t.test("the phone agenda lists only days with items and today, every chip shown", async () => {
              await expect(grid.getByRole("columnheader").filter({ visible: true })).toHaveCount(0);
              const shown = await grid
                .locator(".cal-day")
                .filter({ visible: true })
                .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-day")));
              assert.deepEqual(shown, [busyDay, "2026-10-20", "2026-10-22", "2026-10-27"]);
              await expect(chips.filter({ visible: true })).toHaveCount(6);
              await expect(busy.locator(".cal-more")).toBeHidden();
              assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
            });
            await t.test("every agenda target is at least 44 px", async () => {
              const small = await grid
                .locator("button")
                .filter({ visible: true })
                .evaluateAll((buttons) =>
                  buttons
                    .map((button) => button.getBoundingClientRect())
                    .filter((box) => box.width < 44 || box.height < 44),
                );
              assert.deepEqual(small, []);
            });
          }

          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });
          await t.test("clicking a chip opens that item in the day panel", async () => {
            await long.click();
            const entry = page.locator('#dayPanelBody .cal-day-entry[data-focus="true"]');
            await expect(entry.getByRole("heading", { name: longTitle })).toBeVisible();
            await expect(entry.getByRole("link", { name: "Synthetic clinic" })).toHaveAttribute(
              "href",
              "/relationships?node=party:synthetic-clinic",
            );
          });
        } finally {
          await page.close();
        }
      });
    }
});
