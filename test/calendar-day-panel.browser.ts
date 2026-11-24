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
const busyDays = [2, 5, 6, 7, 8, 9, 12, 13, 14, 15, 16, 19, 22, 23, 26, 27].map(
  (day) => `2026-10-${String(day).padStart(2, "0")}`,
);
// Oct 29 sits in the month's last row and holds more items than any screen shows at once.
const fullDay = "2026-10-29";
const fullDayLetters = "ABCDEFGHIJKLM".split("");
const calendar = {
  schema_version: "calendar-critical-dates.v1",
  critical_dates: [],
  next_steps: [
    ...busyDays.flatMap((day) => ["A", "B", "C"].map((letter) => step(day, letter))),
    ...fullDayLetters.map((letter) => step(fullDay, letter)),
  ],
};

const onScreen = (locator: Locator) =>
  locator.evaluate((node) => {
    const box = node.getBoundingClientRect();
    return box.top >= 0 && box.left >= 0 && box.bottom <= innerHeight && box.right <= innerWidth;
  });

async function expectSheetOnScreen(page: Page, day: RegExp) {
  const title = page.locator("#dayPanelTitle");
  await expect(title).toHaveText(day);
  await expect.poll(() => onScreen(title), { message: "the day title is on screen" }).toBe(true);
  await expect
    .poll(() => onScreen(page.getByRole("button", { name: "Close day" })), { message: "Close is on screen" })
    .toBe(true);
  await expect.poll(() => onScreen(page.locator("#dayPanel")), { message: "the whole sheet is on screen" }).toBe(true);
}

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

test("A chosen day opens on screen from every entry point and closing it returns focus", async (t) => {
  const outDir = await temporaryDirectory("calendar-day-panel-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-day-panel");
  await mkdir(evidence, { recursive: true });
  const month = "view=month&d=2026-10-01";

  for (const theme of ["light", "dark"])
    await t.test(`1440 ${theme}`, async (t) => {
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
      try {
        await openCalendar(page, server, `1440-${theme}`, theme, month);
        const full = page.locator(`#calGrid .cal-day[data-day="${fullDay}"]`);

        await t.test("a full last-row day opens with title and Close on screen after scrolling down", async () => {
          await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
          const more = full.getByRole("button", { name: /^\d+ more on/ });
          await more.click();
          await expectSheetOnScreen(page, /Oct 29/);
          const entries = page.locator("#dayPanelBody .cal-day-entry");
          await expect(entries).toHaveCount(fullDayLetters.length);
          const last = entries.last();
          await page.locator("#dayPanelBody").evaluate((body) => body.scrollTo(0, body.scrollHeight));
          await expect.poll(() => onScreen(last), { message: "the last item scrolls into the sheet" }).toBe(true);
          await expect
            .poll(() => onScreen(page.locator("#dayPanelTitle")), { message: "the title stays put" })
            .toBe(true);
          await page.screenshot({ path: join(evidence, `sheet-1440-${theme}.png`) });
          await page.keyboard.press("Escape");
          await expect(page.locator("#dayPanel")).toBeHidden();
          await expect(more).toBeFocused();
        });

        await t.test("a chip opens its item on screen and Close returns focus to the chip", async () => {
          const chip = full.locator(".cal-chip").first();
          await chip.click();
          await expectSheetOnScreen(page, /Oct 29/);
          const entry = page.locator('#dayPanelBody .cal-day-entry[data-focus="true"]');
          await expect(entry).toContainText("Synthetic step A for 2026-10-29");
          await expect.poll(() => onScreen(entry), { message: "the clicked item is on screen" }).toBe(true);
          await page.getByRole("button", { name: "Close day" }).click();
          await expect(page.locator("#dayPanel")).toBeHidden();
          await expect(chip).toBeFocused();
        });

        await t.test("the day number opens the day on screen and Escape returns focus to it", async () => {
          const open = page.locator('.cal-day-open[data-select-day="2026-10-26"]');
          await open.click();
          await expectSheetOnScreen(page, /Oct 26/);
          await page.keyboard.press("Escape");
          await expect(open).toBeFocused();
        });

        await t.test("arrows move between days without opening one, and Enter opens it on screen", async () => {
          await page.keyboard.press("ArrowRight");
          const next = page.locator('.cal-day-open[data-select-day="2026-10-27"]');
          await expect(next).toBeFocused();
          await expect(page.locator("#dayPanel")).toBeHidden();
          await page.keyboard.press("Enter");
          await expectSheetOnScreen(page, /Oct 27/);
          await expect(next).toBeFocused();
          await page.keyboard.press("Escape");
          await expect(next).toBeFocused();
        });

        await t.test("with a day open, the grid clears the sheet and another day opens in one click", async () => {
          await page.locator('.cal-day-open[data-select-day="2026-10-02"]').click();
          await expectSheetOnScreen(page, /Oct 2\b/);
          const [grid, sheet] = await Promise.all(
            ["#calGrid", "#dayPanel"].map((selector) =>
              page.locator(selector).evaluate((node) => node.getBoundingClientRect().toJSON()),
            ),
          );
          assert.ok(grid.right <= sheet.left, `Saturday ends at ${grid.right}, left of the sheet at ${sheet.left}`);
          await page.locator('.cal-day-open[data-select-day="2026-10-03"]').click();
          await expectSheetOnScreen(page, /Oct 3\b/);
          await page.keyboard.press("Escape");
          await expect(page.locator("#dayPanel")).toBeHidden();
        });
      } finally {
        await page.close();
      }
    });

  for (const theme of ["light", "dark"])
    await t.test(`390 ${theme}`, async (t) => {
      const page = await browser.newPage({ viewport: { width: 390, height: 844 }, reducedMotion: "reduce" });
      try {
        await openCalendar(page, server, `390-${theme}`, theme, month);

        await t.test("a Coming up item opens its day on screen and closing returns focus to it", async () => {
          const item = page.getByRole("region", { name: "Coming up" }).getByRole("button", { name: /^Oct 22\b/ });
          await item.click();
          await expectSheetOnScreen(page, /Oct 22/);
          const first = page.locator("#dayPanelBody .cal-day-entry").first();
          await expect.poll(() => onScreen(first), { message: "the first item is on screen" }).toBe(true);
          await page.screenshot({ path: join(evidence, `sheet-390-${theme}.png`) });
          await page.getByRole("button", { name: "Close day" }).click();
          await expect(item).toBeFocused();
        });

        await t.test("a chip in the phone agenda opens its day on screen", async () => {
          const chip = page.locator(`#calGrid .cal-chip[data-day="${fullDay}"]`).last();
          await chip.click();
          await expectSheetOnScreen(page, /Oct 29/);
          const entry = page.locator('#dayPanelBody .cal-day-entry[data-focus="true"]');
          await expect.poll(() => onScreen(entry), { message: "the tapped item is on screen" }).toBe(true);
          await page.keyboard.press("Escape");
          await expect(chip).toBeFocused();
        });

        await t.test("closing an empty day on a phone moves focus to a day still shown", async () => {
          await page.goto(`${app}/calendar?${month}&day=2026-10-21`);
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
          await page.screenshot({ path: join(evidence, `week-390-${theme}.png`), fullPage: true });
        });
      } finally {
        await page.close();
      }
    });
});

test("The open day alone decides the sheet through month moves, Escape, a late close and the phone breakpoint", async (t) => {
  const outDir = await temporaryDirectory("calendar-day-sheet-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
  t.after(() => page.close());
  await openCalendar(page, server, "sheet-state", "light", "view=month&d=2026-10-01");
  const sheet = page.locator("#dayPanel");
  const modal = () => sheet.evaluate((node) => node.matches(":modal"));
  const dayButton = (day: string) => page.locator(`.cal-day-open[data-select-day="${day}"]`);
  const fresh = async () => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.goto(`${app}/calendar?view=month&d=2026-10-01`);
    await expect(page.locator("#calAsOf")).toContainText("Updated");
  };

  await t.test("a month move closes a day it leaves behind and a view switch keeps one it still shows", async () => {
    await fresh();
    await dayButton("2026-10-22").click();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 22/);
    await page.getByRole("button", { name: "Week", exact: true }).click();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 22/);
    await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(3);
    await page.getByRole("button", { name: "Month", exact: true }).click();
    await page.getByRole("button", { name: "Next month" }).click();
    await expect(sheet).toBeHidden();
    assert.equal(new URL(page.url()).searchParams.get("day"), null, "the address drops the closed day");
    await page.getByRole("button", { name: "Previous month" }).click();
    await expect(sheet).toBeHidden();
  });

  await t.test("Escape closes an open menu first and the day only on the next press", async () => {
    await fresh();
    await dayButton("2026-10-22").click();
    await expect(sheet).toBeVisible();
    const avatar = page.locator("#selfAvatar");
    await avatar.click();
    await expect(page.locator("#accountMenu")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.locator("#accountMenu")).toBeHidden();
    await expect(sheet).toBeVisible();
    await dayButton("2026-10-22").focus();
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await t.test("opening a day beside the grid keeps focus on the day, in this month or another", async () => {
    await fresh();
    await dayButton("2026-10-22").click();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 22/);
    await expect(dayButton("2026-10-22")).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(dayButton("2026-10-23")).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 23/);
    await expect(dayButton("2026-10-23")).toBeFocused();
    await page.locator('#calGrid .cal-day[data-out-month="true"] .cal-day-open[data-select-day="2026-11-01"]').click();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Nov 1\b/);
    await expect(dayButton("2026-11-01")).toBeFocused();
  });

  await t.test("Escape closes the beside sheet when nothing has focus", async () => {
    await fresh();
    await dayButton("2026-10-22").click();
    await expect(sheet).toBeVisible();
    await page.evaluate(() => {
      if (document.activeElement instanceof HTMLElement) document.activeElement.blur();
    });
    await page.keyboard.press("Escape");
    await expect(sheet).toBeHidden();
  });

  await t.test("a width between the phone and wide breakpoints still keeps the sheet off the grid", async () => {
    // A viewport is whole CSS pixels; a frame zoomed to 2 lays its page out at 640.5 px.
    const host = await browser.newPage({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" });
    try {
      await openCalendar(host, server, "sheet-fraction", "light", "view=month&d=2026-10-01");
      await host.route(`${app}/calendar?**`, async (route) => {
        const url = new URL(route.request().url());
        const response = await host.request.fetch(`${server.origin}${url.pathname}${url.search}`);
        const headers = { ...response.headers() };
        delete headers["x-frame-options"];
        delete headers["content-security-policy"];
        await route.fulfill({ response, headers });
      });
      await host.evaluate((src) => {
        const frame = document.createElement("iframe");
        Object.assign(frame.style, { width: "640.5px", height: "400px", border: "0", zoom: "2" });
        frame.src = src;
        document.body.replaceChildren(frame);
      }, `${app}/calendar?view=month&d=2026-10-01&day=2026-10-22`);
      const frame = host.frameLocator("iframe");
      await expect(frame.locator("#calAsOf")).toContainText("Updated");
      await expect(frame.locator("#dayPanel")).toBeVisible();
      const fit = await frame.locator("#dayPanel").evaluate((sheet) => ({
        between: matchMedia("(width > 640px) and (width < 641px)").matches,
        modal: sheet.matches(":modal"),
        gridRight: document.querySelector("#calGrid")?.getBoundingClientRect().right ?? Number.POSITIVE_INFINITY,
        sheetLeft: sheet.getBoundingClientRect().left,
      }));
      assert.ok(fit.between, "the frame sits between the two whole-pixel breakpoints");
      assert.ok(fit.modal || fit.gridRight <= fit.sheetLeft, `a beside sheet clears the grid: ${JSON.stringify(fit)}`);
    } finally {
      await host.close();
    }
  });

  await t.test("closing one day and opening the next in the same task leaves the next day open", async () => {
    await fresh();
    await dayButton("2026-10-22").click();
    await expect(sheet).toBeVisible();
    await page.evaluate(() => {
      document.querySelector<HTMLButtonElement>("#dayPanelClose")?.click();
      document.querySelector<HTMLButtonElement>('.cal-day-open[data-select-day="2026-10-23"]')?.click();
    });
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 0)));
    await expect(sheet).toBeVisible();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 23/);
  });

  await t.test("the sheet turns modal below 641 px and back beside the grid above it", async () => {
    await fresh();
    await dayButton("2026-10-23").click();
    await expect.poll(modal, { message: "a wide sheet is not modal" }).toBe(false);
    await page.setViewportSize({ width: 390, height: 844 });
    await expect.poll(modal, { message: "a phone sheet is modal" }).toBe(true);
    await expect(page.getByRole("dialog", { name: /Oct 23/ })).toBeVisible();
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect.poll(modal, { message: "a wide sheet sits beside the grid" }).toBe(false);
    await dayButton("2026-10-26").click();
    await expect(page.locator("#dayPanelTitle")).toHaveText(/Oct 26/);
  });
});
