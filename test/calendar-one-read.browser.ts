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
const calendarRead = "/api/engine/calendar/critical-dates";
const stepTitle = "Send revised offer for ExampleLeaseRenewalPackageRevision20261020";
const upcomingTitle = "Confirm the proposed suite dimensions with the property manager and the tenant in writing.";
const stepWhy = "The owner asked for an update on <Suite A> & parking.";

test("Calendar reads once and shows dates and next steps in the visible period", async (t) => {
  const outDir = await temporaryDirectory("calendar-one-read-");
  t.after(() => rm(outDir, { recursive: true, force: true }));
  await buildArtifact({ root, outDir, commit: "0".repeat(40) });
  const server = await (await createQaServer({ buildRoot: join(outDir, "site") })).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const evidence = join(root, "test-artifacts/calendar-one-read");
  await mkdir(evidence, { recursive: true });

  for (const width of [390, 1440])
    for (const theme of ["light", "dark"]) {
      await t.test(`${width} ${theme}`, async (t) => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const reads: string[] = [];
        await page.clock.install({ time: new Date("2026-10-20T15:00:00Z") });
        await page.addInitScript((theme) => {
          localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
          localStorage.setItem("doctorcre:today", "closed");
        }, theme);
        await page.route("**/*", async (route) => {
          const request = route.request();
          const url = new URL(request.url());
          if (url.origin !== app) return route.abort();
          if (url.pathname === calendarRead) {
            reads.push(url.pathname);
            return route.fulfill({
              json: {
                schema_version: "calendar-critical-dates.v1",
                critical_dates: [
                  {
                    id: "a",
                    deal_id: "qa-deal-1",
                    deal_name: "Example lease",
                    kind: "LOI expiry",
                    owner: "joe",
                    due_on: "2026-10-20",
                    done: false,
                  },
                  {
                    id: "b",
                    deal_id: "qa-deal-1",
                    deal_name: "Example lease",
                    kind: "Option notice",
                    owner: "dell",
                    due_on: "2026-10-26",
                    done: false,
                  },
                  {
                    id: "c",
                    deal_id: "qa-deal-2",
                    deal_name: "Example expansion",
                    kind: "Due diligence",
                    owner: "joe",
                    due_on: "2026-11-01",
                    done: false,
                  },
                ],
                next_steps: [
                  {
                    id: "step-a",
                    what: stepTitle,
                    why: stepWhy,
                    owner: "joe",
                    record_label: "Example lease",
                    due_on: "2026-10-17",
                    display_on: "2026-10-20",
                    days_late: 3,
                    open_url: "/deals?deal=qa-deal-1&focus=next-step&step=step-a",
                  },
                  {
                    id: "step-parking",
                    what: "Confirm parking",
                    owner: "dell",
                    record_label: "Example lease",
                    due_on: "2026-10-19",
                    display_on: "2026-10-20",
                    days_late: 1,
                    open_url: "/relationships?node=party:example-clinic",
                  },
                  ...["22", "24", "26", "30"].map((day) => ({
                    id: `step-${day}`,
                    what: day === "30" ? upcomingTitle : "Confirm suite availability",
                    ...(day === "22" ? { why: null } : {}),
                    owner: "dell",
                    record_label: "Example clinic",
                    due_on: `2026-10-${day}`,
                    display_on: `2026-10-${day}`,
                    days_late: 0,
                    open_url: "/relationships?node=party:example-clinic",
                  })),
                ],
              },
            });
          }
          if (url.pathname === "/mcp") {
            const verb = request.postDataJSON()?.params?.name;
            if (verb === "get-deal-room") reads.push(verb);
          }
          const response = await page.request.fetch(`${server.origin}${url.pathname}${url.search}`, {
            method: request.method(),
            data: request.postData() ?? undefined,
            headers: { "content-type": "application/json" },
          });
          if (url.pathname === "/calendar") {
            return route.fulfill({
              response,
              body: (await response.text()).replace("<html ", "<html data-home-today-from-engine "),
            });
          }
          return route.fulfill({ response });
        });
        try {
          await page.request.post(`${server.origin}/api/test/seed`, {
            data: { namespace: `calendar-one-read-${width}-${theme}`, reset: true },
          });
          await page.goto(`${app}/calendar?view=month&d=2026-10-01&day=2026-10-20`);
          await expect(page.locator("#calAsOf")).toContainText("Updated");
          await expect(page.locator("#calStatus")).toHaveCount(0);
          await expect(page.getByText("Critical dates from open deals")).toHaveCount(0);
          await expect(page.getByRole("complementary", { name: "Today", exact: true })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Close Today" })).toHaveCount(0);
          await expect(page.getByRole("button", { name: "Today sidebar" })).toHaveCount(0);
          const appControls = page.getByRole("region", { name: "App controls" });
          await expect(appControls.getByRole("button", { name: /Search.*Quick switcher/i })).toBeVisible();
          const geometry = await page.evaluate(() => {
            const box = (id: string) => document.getElementById(id)?.getBoundingClientRect();
            return {
              arrowsBracketTitle:
                Number(box("calPrev")?.right) <= Number(box("calPeriod")?.left) &&
                Number(box("calPeriod")?.right) <= Number(box("calNext")?.left),
              sheet: box("dayPanel")?.toJSON(),
              viewport: { width: innerWidth, height: innerHeight },
            };
          });
          assert.equal(geometry.arrowsBracketTitle, true);
          const { sheet, viewport } = geometry;
          assert.equal(sheet.bottom, viewport.height, "the day sheet reaches the bottom of the screen");
          if (width === 1440) assert.equal(sheet.right, viewport.width, "the day sheet is pinned to the right edge");
          else assert.equal(sheet.width, viewport.width, "the day sheet spans the phone");
          const panel = page.locator("#dayPanelBody");
          const step = panel.locator(".cal-day-entry").filter({ hasText: stepTitle });
          const title = step.getByRole("heading", { name: stepTitle });
          await expect(title).toBeVisible();
          assert.equal(
            await title.evaluate((node) => {
              const panel = node.closest("#dayPanel");
              return (
                node.scrollWidth <= node.clientWidth &&
                node.getBoundingClientRect().right <= (panel?.getBoundingClientRect().right ?? 0)
              );
            }),
            true,
            "The full step title fits inside the selected-day panel",
          );
          await t.test("the reason appears as plain muted text beneath the title", async () => {
            const reason = title.locator("+ p").filter({ hasText: stepWhy });
            await expect(reason).toBeVisible();
            await expect(reason).toHaveText(stepWhy);
            await expect(reason).toHaveCSS("color", await panel.evaluate((node) => getComputedStyle(node).color));
          });
          await expect(step).toContainText("Next step · Joe");
          await expect(step).toContainText("3 days late");
          await t.test("late steps appear before today's dates and stay off the original due day", async () => {
            const late = panel.getByRole("region", { name: "Late" });
            await expect(late.getByRole("heading", { name: stepTitle })).toBeVisible();
            await expect(late.getByRole("heading", { name: "Confirm parking" })).toBeVisible();
            await expect(late.getByText(/1 day late/)).toBeVisible();
            await expect(late.getByText("LOI expiry")).toHaveCount(0);
            assert.equal(await panel.getByRole("heading").first().textContent(), "Late");
            const dueDay = page.locator('[data-select-day="2026-10-17"]');
            await page.keyboard.press("Escape");
            if (width === 390) await expect(dueDay, "the phone agenda leaves the empty due day out").toBeHidden();
            else {
              await dueDay.click();
              await expect(late).toHaveCount(0);
              await expect(panel.getByText(stepTitle)).toHaveCount(0);
              await page.keyboard.press("Escape");
            }
            const lateChip = page.getByRole("button", { name: "2 late steps", exact: true });
            await expect(lateChip).toHaveCount(1);
            await expect(lateChip).toBeVisible();
            await expect(lateChip).toHaveText("2 late");
            await lateChip.click();
          });
          await expect(step.getByRole("link")).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-1&focus=next-step&step=step-a",
          );
          await expect(panel.locator(".cal-day-entry").filter({ hasText: "LOI expiry" })).toContainText(
            "Critical date · Joe",
          );
          assert.deepEqual(reads, [calendarRead]);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#calCount")).toHaveText("6 next steps · 2 critical dates");
          await t.test("the period total appears once", async () => {
            const total = page.getByText("6 next steps · 2 critical dates", { exact: true });
            await expect(total).toHaveCount(1);
            await expect(total).toBeVisible();
            await expect(total).toHaveAttribute("aria-live", "polite");
          });
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(7);
          if (width === 1440) {
            const chip = page.getByRole("button", { name: new RegExp(upcomingTitle) }).locator(".cal-chip-label");
            await expect(chip).toBeVisible();
            assert.ok(await chip.evaluate((node) => node.scrollHeight <= node.clientHeight));
          }
          await expect(page.locator("#calAgenda .cal-agenda-item")).toHaveCount(5);
          await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(3);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });
          await page.locator("#dayPanel").screenshot({ path: join(evidence, `day-${width}-${theme}.png`) });

          // A wide month shows every day, so only the phone keeps Coming up; there a day opens from it.
          const comingUpPanel = page.getByRole("region", { name: "Coming up" });
          const upcoming = (day: string) =>
            width === 390
              ? comingUpPanel.getByRole("button", { name: new RegExp(`^${day}\\b`) })
              : page.locator(`.cal-day-open[data-select-day="2026-10-${day.slice(4)}"]`);
          if (width === 390)
            await t.test("Coming up names every item due", async () => {
              await expect(upcoming("Oct 22")).toContainText("Confirm suite availability");
              await expect(upcoming("Oct 22")).toContainText("Dell");
              const twoItems = upcoming("Oct 26");
              await expect(twoItems).toContainText("Confirm suite availability");
              await expect(twoItems).toContainText("Option notice");
            });
          else await expect(comingUpPanel).toBeHidden();
          await page.keyboard.press("Escape");
          await upcoming("Oct 22").click();
          await expect(panel).toContainText("Confirm suite availability");
          await expect(panel).toContainText("Next step · Dell");
          await expect(panel.getByRole("link", { name: "Example clinic" })).toHaveAttribute(
            "href",
            "/relationships?node=party:example-clinic",
          );
          await t.test("a short step appears once when the engine omits its body", async () => {
            await expect(panel).toHaveText("Next step · Dell Confirm suite availability Example clinic");
            await page.keyboard.press("Escape");
            await upcoming("Oct 24").click();
            await expect(panel).toHaveText("Next step · Dell Confirm suite availability Example clinic");
          });
          await page.keyboard.press("Escape");
          const todayButton = page.getByRole("button", { name: "Today", exact: true });
          const todayCell = page.locator('.cal-day-open[data-select-day="2026-10-20"]');
          await t.test("Today opens the Day view without its sheet; the day opens from its header", async () => {
            await page.getByRole("button", { name: "Next month" }).click();
            await todayButton.click();
            await expect(page.locator("#calPeriod")).toHaveText("Tuesday, Oct 20, 2026");
            await expect(todayCell).toBeFocused();
            await expect(page.locator("#dayPanel")).toBeHidden();
            await page.keyboard.press("Enter");
            await expect(step).toBeVisible();
            await page.keyboard.press("Escape");
            await page.getByRole("button", { name: "Month", exact: true }).click();
          });
          const week = page.getByRole("button", { name: "Week", exact: true });
          await expect(week).toHaveCSS("border-top-width", "0px");
          const background = await week.evaluate((node) => getComputedStyle(node).backgroundColor);
          await week.hover();
          await expect(week).not.toHaveCSS("background-color", background);
          await week.click();
          await expect(week).toHaveAttribute("aria-pressed", "true");
          await expect(page.locator("#calCount")).toHaveText("4 next steps · 1 critical date");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(4);
          const lateChip = page.getByRole("button", { name: "2 late steps", exact: true });
          await expect(lateChip).toBeVisible();
          await expect(lateChip).toHaveCount(1);
          await page.getByRole("button", { name: "Month", exact: true }).click();
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("0 items");
          await expect(page.locator("#calState")).toHaveText("Nothing this month.");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(0);
          assert.deepEqual(reads, [calendarRead]);

          await page.getByRole("button", { name: "Previous month" }).click();
          await page.getByRole("button", { name: "Previous month" }).click();
          const updated = page.locator("#calAsOf");
          const record = step.getByRole("link");
          const focusRetained: boolean[] = [];
          await todayCell.click();
          for (const minute of [1, 2, 3, 4, 5]) {
            if (minute === 2) await page.keyboard.press("Escape");
            const focused = minute === 1 ? record : upcoming("Oct 22");
            await focused.focus();
            const previous = await updated.textContent();
            await page.clock.setSystemTime(new Date(Date.UTC(2026, 9, 20, 15, minute)));
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect(updated).toContainText("Updated");
            await expect(updated).not.toHaveText(previous ?? "");
            assert.equal(reads.length, minute + 1);
            focusRetained.push(await focused.evaluate((node) => node === document.activeElement));
          }
          await t.test("quiet refresh preserves focus on record links and upcoming dates", () => {
            assert.deepEqual(focusRetained, [true, true, true, true, true]);
          });
          await t.test("a sixth focus keeps the last data until the deferred read", async () => {
            const previous = await updated.textContent();
            await page.evaluate(() => window.dispatchEvent(new Event("focus")));
            await expect(upcoming("Oct 22")).toBeVisible({ timeout: 500 });
            await expect(updated).toHaveText(previous ?? "");
            assert.equal(reads.length, 6);
            await page.clock.fastForward(120_000);
            await expect(updated).not.toHaveText(previous ?? "");
            assert.equal(reads.length, 7);
          });
          await todayButton.click();
          await todayCell.click();
          await panel.locator(".cal-day-entry").filter({ hasText: "LOI expiry" }).getByRole("link").click();
          await page.waitForURL((url) => url.pathname === "/deals" && url.searchParams.get("deal") === "qa-deal-1");
          await expect(page.locator("#recordPanel .deal-opening-snapshot")).toBeVisible();
          await page.goBack();
          await expect(updated).toContainText("Updated");
          await t.test("failed refresh keeps dates until retry and session expiry clears them", async () => {
            const previous = await updated.textContent();
            await page.route(`**${calendarRead}`, async () => {});
            await page.keyboard.press("Escape");
            await page.locator("#calRefresh").click();
            await page.clock.fastForward(10_001);
            await expect(page.locator("#calNotices").getByText("Calendar could not refresh. Try again.")).toBeVisible();
            await expect(
              page.locator('#calGrid .cal-chip[data-day="2026-10-20"]').filter({ hasText: "LOI expiry" }),
            ).toHaveCount(1);
            await expect(page.locator('[data-day="2026-10-20"][aria-selected="true"]')).toHaveCount(1);
            await expect(updated).toHaveText(previous ?? "");
            await page.unroute(`**${calendarRead}`);
            await page.route(`**${calendarRead}`, (route) =>
              route.fulfill({
                json: {
                  schema_version: "calendar-critical-dates.v1",
                  critical_dates: [
                    {
                      id: "new",
                      deal_id: "qa-deal-1",
                      deal_name: "Example lease",
                      kind: "New date",
                      due_on: "2026-10-20",
                      done: false,
                    },
                  ],
                },
              }),
            );
            await page.clock.setSystemTime(new Date("2026-10-20T15:10:00Z"));
            await page.getByRole("button", { name: "Retry" }).click();
            await expect(updated).not.toHaveText(previous ?? "");
            await expect(
              page.locator('#calGrid .cal-chip[data-day="2026-10-20"]').filter({ hasText: "New date" }),
            ).toHaveCount(1);
            await page.unroute(`**${calendarRead}`);
            await expect(page.locator("#calNotices").getByText("Calendar could not refresh. Try again.")).toHaveCount(
              0,
            );
            await page.route(`**${calendarRead}`, (route) => route.fulfill({ status: 401 }));
            await page.locator("#calRefresh").click();
            await expect(page.getByRole("heading", { name: "Session ended" })).toBeVisible();
            await expect(page.locator("#calGrid .cal-chip")).toHaveCount(0);
            await expect(updated).toHaveCount(0);
          });
        } finally {
          await page.close();
        }
      });
    }
});
