import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";

const screens = [
  { path: "/", name: "Home", ready: "#homeRoot[data-home-ready]" },
  { path: "/deals", name: "Deals", ready: ".card-open" },
  { path: "/leads", name: "Leads", ready: "#leadBoard .lead-card" },
];
const captures = "out/test-artifacts/app-shell-navigation";

test("Shared shell navigation and controls work on real fixture pages at desktop and phone widths", async (t) => {
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(captures, { recursive: true });

  for (const width of [1440, 390])
    for (const theme of ["light", "dark"]) {
      await t.test(`${width} ${theme}`, async (t) => {
        const page = await browser.newPage({ viewport: { width, height: 900 }, hasTouch: width === 390 });
        t.after(() => page.close());
        await page.addInitScript((theme) => {
          localStorage.setItem(
            "doctorcre.visual-preferences",
            JSON.stringify({
              theme,
              walkthroughSeen: { joe: true, dell: true },
            }),
          );
        }, theme);
        await page.request.post(`${server.origin}/api/test/seed`, {
          data: { namespace: `shell-${width}-${theme}`, viewer: "joe", reset: true },
        });
        for (const screen of screens) {
          await page.goto(`${server.origin}${screen.path}`);
          await page.locator(screen.ready).first().waitFor({ state: "attached" });
          const primary = page.getByRole("navigation", { name: "Primary navigation" });
          const links = primary.locator(":scope > a");
          assert.deepEqual(await links.evaluateAll((nodes) => nodes.map((node) => node.textContent?.trim())), [
            "Home",
            "Deals",
            "Leads",
            "Vendors",
          ]);
          assert.equal(
            await primary.getByRole("link", { name: screen.name, exact: true }).getAttribute("aria-current"),
            "page",
          );
          assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);

          const shell = page.locator(".app-shell-header");
          const box = await shell.boundingBox();
          assert.ok(box);
          if (width === 1440) {
            assert.ok(box.x > 0 && box.y > 0 && box.width <= 56, "desktop rail floats with a narrow inset");
            assert.equal(await shell.evaluate((node) => getComputedStyle(node).borderRightWidth), "0px");
          } else assert.ok(box.y >= 840 && box.width === width, "phone navigation is one bottom row");

          const appControls = page.getByRole("region", { name: "App controls" });
          const display = width === 390 ? page.locator("#accountMenu") : appControls;
          const darkMode = display.getByRole("button", { name: "Dark mode", exact: true });
          const colorAssist = display.getByRole("button", { name: "Color assist", exact: true });
          assert.ok(await appControls.getByRole("button", { name: /Search.*Quick switcher/i }).isVisible());
          assert.equal(await page.locator(".app-shell-search").count(), 1);
          assert.equal(await darkMode.isVisible(), width === 1440);
          assert.equal(await colorAssist.isVisible(), width === 1440);
          assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
          await page.screenshot({ path: `${captures}/${screen.name.toLowerCase()}-${width}-${theme}.png` });

          await links.first().focus();
          for (const destination of ["Home", "Deals", "Leads", "Vendors", "More"]) {
            assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("aria-label")), destination);
            if (destination !== "More") await page.keyboard.press("Tab");
          }
          await page.keyboard.press("Enter");
          const more = primary.locator(".app-shell-more-list");
          assert.equal(await more.getByRole("link", { name: "Clients" }).getAttribute("href"), "/clients");
          assert.equal(await more.getByRole("link", { name: "Calendar" }).getAttribute("href"), "/calendar");
          assert.equal(await primary.locator('a[href="/tours"]').count(), 0);
          assert.equal(await primary.locator("a:not(:has(svg))").count(), 0);
          if (screen.path === "/") {
            await page.screenshot({ path: `${captures}/more-${width}-${theme}.png` });
          }
          await page.keyboard.press("Escape");
          assert.equal(await more.isHidden(), true);

          await page.locator("#selfAvatar").click();
          assert.ok((await darkMode.isVisible()) && (await colorAssist.isVisible()));
          assert.ok(await page.getByRole("button", { name: "Check call recorder status" }).isVisible());
          await page.keyboard.press("Escape");
        }
        const search = page.getByRole("button", { name: /Search.*Quick switcher/i });
        await search.focus();
        await page.keyboard.press("Control+K");
        const switcher = page.getByRole("dialog", { name: "Quick switcher" });
        await switcher.getByRole("combobox", { name: "Jump to" }).fill("Calendar");
        assert.ok(await switcher.getByRole("option", { name: /Calendar/ }).isVisible());
        await switcher.getByRole("combobox", { name: "Jump to" }).fill("Demo Dental");
        await switcher.getByRole("link", { name: "Search all records" }).click();
        await page.waitForURL(/\/search\?q=Demo(?:%20|\+)Dental$/);
        await page.waitForFunction(() => {
          const input = document.getElementById("searchQuery");
          return input instanceof HTMLInputElement && input.value === "Demo Dental";
        });
        assert.equal((await page.request.get(`${server.origin}/tours`)).ok(), true);
      });
    }
});
