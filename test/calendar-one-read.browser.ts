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
      await t.test(`${width} ${theme}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, reducedMotion: "reduce" });
        const reads: string[] = [];
        await page.clock.setFixedTime(new Date("2026-10-20T15:00:00Z"));
        await page.addInitScript((theme) => {
          localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
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
                    due_on: "2026-10-28",
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
                    owner: "joe",
                    record_label: "Example lease",
                    due_on: "2026-10-17",
                    display_on: "2026-10-20",
                    days_late: 3,
                    open_url: "/deals?deal=qa-deal-1&focus=next-step&step=step-a",
                  },
                  ...["22", "24", "26", "30"].map((day) => ({
                    id: `step-${day}`,
                    what: "Confirm suite availability",
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
          return route.fulfill({ response });
        });
        try {
          await page.request.post(`${server.origin}/api/test/seed`, {
            data: { namespace: `calendar-one-read-${width}-${theme}`, reset: true },
          });
          await page.goto(`${app}/calendar?view=month&d=2026-10-01&day=2026-10-20`);
          await expect(page.locator("#calStatusLabel")).toHaveText("Current");
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
          await expect(step).toContainText("Next step · Joe");
          await expect(step).toContainText("3 days late");
          await expect(step.getByRole("link")).toHaveAttribute(
            "href",
            "/deals?deal=qa-deal-1&focus=next-step&step=step-a",
          );
          await expect(panel.locator(".cal-day-entry").filter({ hasText: "LOI expiry" })).toContainText(
            "Critical date · Joe",
          );
          assert.deepEqual(reads, [calendarRead]);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#calCount")).toHaveText("5 next steps · 2 critical dates");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(7);
          await expect(page.locator("#calAgenda .cal-agenda-item")).toHaveCount(7);
          await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(2);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });

          await page.getByRole("button", { name: "Week", exact: true }).click();
          await expect(page.locator("#calCount")).toHaveText("3 next steps · 1 critical date");
          await expect(page.locator("#calAgenda .cal-agenda-item")).toHaveCount(4);
          await page.getByRole("button", { name: "Month", exact: true }).click();
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("0 items");
          await expect(page.locator("#calAgenda")).toHaveText("No critical dates this month.");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(0);
          assert.deepEqual(reads, [calendarRead]);

          await page.getByRole("button", { name: "Previous month" }).click();
          await page.getByRole("button", { name: "Previous month" }).click();
          await panel.locator(".cal-day-entry").filter({ hasText: "LOI expiry" }).getByRole("link").click();
          await page.waitForURL((url) => url.pathname === "/deals" && url.searchParams.get("deal") === "qa-deal-1");
          await expect(page.locator("#recordPanel .deal-opening-snapshot")).toBeVisible();
        } finally {
          await page.close();
        }
      });
    }
});
