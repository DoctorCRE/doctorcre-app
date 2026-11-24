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
    { ...step("s-late", "2026-10-20", "Synthetic late step"), due_on: "2026-10-17", days_late: 3 },
  ],
};

test("Calendar month grid marks today, marks chips by kind, folds overflow and turns into an agenda on a phone", async (t) => {
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
          const mark = (locator: typeof step) =>
            locator.locator(".cal-mark").evaluate((node) => {
              const style = getComputedStyle(node);
              return { color: style.backgroundColor, shape: style.transform };
            });
          const stepMark = await mark(step);
          const dateMark = await mark(date);
          assert.notEqual(stepMark.color, dateMark.color, "a next step and a critical date have different mark colors");
          assert.notEqual(stepMark.shape, dateMark.shape, "and different mark shapes");
          assert.equal(await tint(step), await tint(date), "chips share one light surface");
          await expect(chips).toHaveCount(6);
          await expect(page.locator(".cal-pulse").filter({ visible: true })).toHaveCount(0);

          const late = grid.getByRole("button", { name: "1 late step", exact: true });
          await expect(late).toHaveAttribute("data-kind", "late");
          await expect(late).toHaveText("1 late");
          const danger = await page.evaluate(() => {
            const probe = document.body.appendChild(document.createElement("i"));
            probe.style.color = "var(--status-danger-ink)";
            const color = getComputedStyle(probe).color;
            probe.remove();
            return color;
          });
          await expect(late.locator(".cal-chip-label")).toHaveCSS("color", danger);
          assert.equal(await tint(late), await tint(step), "a late chip is light too");

          const long = grid.getByRole("button", { name: new RegExp(longTitle) });
          const line = await long.locator(".cal-chip-label").evaluate((node) => ({
            height: node.getBoundingClientRect().height,
            lineHeight: Number.parseFloat(getComputedStyle(node).lineHeight),
          }));
          assert.ok(line.height <= line.lineHeight + 1, "a long title stays on one line");
          await expect(long).toHaveAttribute("title", longTitle);

          if (width === 1440) {
            await t.test("with no day chosen the grid fills the page and the panel stays closed", async () => {
              await expect(page.locator("#dayPanel")).toBeHidden();
              await expect(page.locator("#appSidebar")).toHaveAttribute("inert", "");
              const day = await grid
                .locator('.cal-day[data-day="2026-10-13"]')
                .evaluate((node) => node.getBoundingClientRect().width);
              assert.ok(day >= 160, `each day is at least 160 px wide (${day})`);
            });
            await t.test("mouse chips are 24 px tall and every week row is the same height", async () => {
              const heights = await chips
                .filter({ visible: true })
                .evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().height));
              assert.ok(heights.length > 0 && heights.every((height) => height === 24), `chip heights: ${heights}`);
              const rows = await grid
                .locator(".cal-week:has(.cal-day)")
                .evaluateAll((nodes) => nodes.map((node) => Math.round(node.getBoundingClientRect().height)));
              assert.equal(rows.length, 6);
              assert.equal(new Set(rows).size, 1, `rows are even: ${rows}`);
            });
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
            await t.test("a full day shows the chips that fit and opens the rest from +N more", async () => {
              const shown = await chips.filter({ visible: true }).count();
              assert.ok(shown >= 1 && shown < 6, `${shown} of 6 chips show`);
              const more = busy.getByRole("button", { name: new RegExp(`^${6 - shown} more on`) });
              await expect(more).toHaveText(`+${6 - shown} more`);
              await expect(more).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
              await more.click();
              await expect(page.locator("#dayPanel")).toBeVisible();
              await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(6);
              await page.getByRole("button", { name: "Close day" }).click();
              await expect(page.locator("#dayPanel")).toBeHidden();
              await expect(more).toBeFocused();
            });
          } else {
            await t.test("the phone agenda lists only days with items and today, every chip shown", async () => {
              await expect(grid.getByRole("columnheader").filter({ visible: true })).toHaveCount(0);
              const shown = await grid
                .locator(".cal-day")
                .filter({ visible: true })
                .evaluateAll((cells) => cells.map((cell) => cell.getAttribute("data-day")));
              assert.deepEqual(shown, [busyDay, "2026-10-20", "2026-10-22", "2026-10-27"]);
              await expect(page.locator("#dayPanel")).toBeHidden();
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
