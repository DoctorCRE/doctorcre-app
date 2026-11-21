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

test("Calendar reads once and lists the dates in the visible period", async (t) => {
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
                    due_on: "2026-10-20",
                    done: false,
                  },
                  {
                    id: "b",
                    deal_id: "qa-deal-1",
                    deal_name: "Example lease",
                    kind: "Option notice",
                    due_on: "2026-10-28",
                    done: false,
                  },
                  {
                    id: "c",
                    deal_id: "qa-deal-2",
                    deal_name: "Example expansion",
                    kind: "Due diligence",
                    due_on: "2026-11-01",
                    done: false,
                  },
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
          assert.deepEqual(reads, [calendarRead]);
          await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
          await expect(page.locator("#calCount")).toHaveText("2 critical dates");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(2);
          await expect(page.locator("#calAgenda .cal-agenda-item")).toHaveCount(2);
          await expect(page.locator("#dayPanelBody .cal-day-entry")).toHaveCount(1);
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
          await page.screenshot({ path: join(evidence, `month-${width}-${theme}.png`), fullPage: true });

          await page.getByRole("button", { name: "Week", exact: true }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await expect(page.locator("#calAgenda .cal-agenda-item")).toHaveCount(1);
          await page.getByRole("button", { name: "Month", exact: true }).click();
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("1 critical date");
          await page.getByRole("button", { name: "Next month" }).click();
          await expect(page.locator("#calCount")).toHaveText("0 critical dates");
          await expect(page.locator("#calAgenda")).toHaveText("No critical dates this month.");
          await expect(page.locator("#calGrid .cal-chip")).toHaveCount(0);
          assert.deepEqual(reads, [calendarRead]);

          await page.getByRole("button", { name: "Previous month" }).click();
          await page.getByRole("button", { name: "Previous month" }).click();
          await page.locator("#dayPanelBody").getByRole("link", { name: "Example lease" }).click();
          await page.waitForURL((url) => url.pathname === "/deals" && url.searchParams.get("deal") === "qa-deal-1");
          await expect(page.locator("#recordPanel .deal-opening-snapshot")).toBeVisible();
        } finally {
          await page.close();
        }
      });
    }
});
