import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { ownedServer } from "../../test/fixture-probe.ts";

let server: Awaited<ReturnType<typeof ownedServer>>;
test.beforeAll(async () => {
  server = await ownedServer();
});
test.afterAll(async () => {
  await server?.stop();
});
test.use({ hasTouch: true, timezoneId: "America/Chicago" });

test.beforeEach(async ({ page }) => {
  await page.route("**/*", (route) =>
    new URL(route.request().url()).origin === server.url ? route.continue() : route.abort(),
  );
  await page.clock.setFixedTime(new Date("2026-10-18T17:05:00Z"));
});

async function expectTouchTargets(controls: Locator) {
  const boxes = await controls.evaluateAll((nodes) =>
    nodes.map((node) => ({
      name: node.getAttribute("aria-label") || node.textContent?.trim() || node.id,
      height: node.getBoundingClientRect().height,
    })),
  );
  expect(boxes.length).toBeGreaterThan(0);
  expect.soft(boxes.filter(({ height }) => height < 44)).toEqual([]);
}

async function enableSwitch(page: Page, routePath: string, attribute: string) {
  await page.route(routePath, async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("<html", `<html ${attribute}`);
    await route.fulfill({ response, body });
  });
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } }),
  );
}

for (const width of [360, 390, 500]) {
  test.describe(`${width}px`, () => {
    test.use({ viewport: { width, height: 844 } });

    test("Calendar timestamp clears Search and the day panel has 44px targets on phones", async ({ page }) => {
      await enableSwitch(page, "**/calendar?*", "data-home-today-from-engine");
      await page.goto(`${server.url}/calendar?view=month&d=2026-10-18`);
      const updated = page.getByRole("main").getByText(/^Updated /);
      const search = page.getByRole("button", { name: /Search and quick switcher/ });
      const dayPanel = page.getByRole("complementary", { name: /Oct 15/ });
      await expect(updated).toBeVisible();
      await expect(search).toBeVisible();
      await page.getByRole("button", { name: /Oct 15, 2026.*critical date/ }).click();
      await expect(dayPanel.getByRole("link").first()).toBeVisible();
      const [time, button] = await Promise.all([updated.boundingBox(), search.boundingBox()]);
      assert.ok(time && button);
      const overlaps =
        time.x < button.x + button.width &&
        button.x < time.x + time.width &&
        time.y < button.y + button.height &&
        button.y < time.y + time.height;
      expect.soft(overlaps, `Calendar header at ${width}px`).toBe(false);
      await expectTouchTargets(dayPanel.locator("a:visible, button:visible"));
      await search.click();
      await expect(page.getByRole("dialog", { name: "Quick switcher" })).toBeVisible();
    });

    test("Updates links and controls have 44px targets on phones", async ({ page }) => {
      await enableSwitch(page, "**/updates?*", "data-deals-saves-from-engine");
      await page.route("**/api/engine/updates", (route) =>
        route.fulfill({
          json: {
            unread_count: 2,
            updates: ["Open deal", "Open checklist item"].map((action, index) => ({
              source_id: `update-${index}`,
              title: `Demo update ${index + 1}`,
              primary_action: action,
              open_url: index ? "/deals?deal=d14&focus=next-step" : "/deals?deal=d14",
              activity_at: "2026-10-18T16:00:00Z",
            })),
          },
        }),
      );
      await page.route("**/api/engine/preferences", (route) =>
        route.fulfill({
          json: {
            time_zone: "America/Chicago",
            push_to_device: false,
            base_version: 1,
            quiet_from: null,
            quiet_until: null,
          },
        }),
      );
      await page.goto(`${server.url}/updates?mode=live`);
      for (const name of ["Open deal", "Open checklist item"]) {
        await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
      }
      const optIn = page.getByRole("checkbox", { name: /Send a device push/ });
      await expect(optIn).toBeEnabled();
      await expectTouchTargets(page.locator("main :is(a, button, summary, input:not(#deviceOptIn), select):visible"));
      const target = optIn.locator("..");
      await expectTouchTargets(target);
      await target.tap({ position: { x: 2, y: 2 } });
      await expect(optIn).toBeChecked();
    });

    test("Deal workspace tabs and inputs fit phones", async ({ page }) => {
      const dealId = "00000000-0000-4000-8000-000000000001";
      const seed = await readFile(new URL("../../data/board-seed.json", import.meta.url), "utf8");
      await page.route("**/data/board-seed.json", (route) =>
        route.fulfill({ json: JSON.parse(seed.replaceAll('"d14"', JSON.stringify(dealId))) }),
      );
      await page.route("**/mcp", (route) => {
        if (route.request().postDataJSON().params.name !== "read-subject-watch-v2") return route.continue();
        const result = { ok: true, schema_version: "subject-watch.v2", watch: null };
        return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(result) }] } } });
      });
      await page.goto(`${server.url}/deals?deal=${dealId}`);
      const room = page.getByRole("main", { name: "Deal Workspace" });
      const tabs = room.getByRole("tablist", { name: "Deal workspace tabs" });
      await expect(tabs.getByRole("tab")).toHaveCount(7);
      const layout = await tabs.evaluate((nav) => {
        const bounds = nav.getBoundingClientRect();
        const buttons = Array.from(nav.querySelectorAll('[role="tab"]'));
        const clipped = buttons
          .filter((tab) => {
            const range = document.createRange();
            range.selectNodeContents(tab);
            const box = tab.getBoundingClientRect();
            const left = Math.max(bounds.left, box.left, 0);
            const right = Math.min(bounds.right, box.right, innerWidth);
            return Array.from(range.getClientRects()).some((rect) => rect.left < left || rect.right > right);
          })
          .map((tab) => tab.textContent);
        return {
          clipped,
          overflow: nav.scrollWidth - nav.clientWidth,
          rows: new Set(buttons.map((tab) => tab.getBoundingClientRect().top)).size,
        };
      });
      expect.soft(layout.clipped, `Deal tab labels at ${width}px`).toEqual([]);
      expect.soft(layout.overflow, `Deal tab overflow at ${width}px`).toBeLessThanOrEqual(0);
      expect.soft(layout.rows, `Deal tab rows at ${width}px`).toBeLessThanOrEqual(2);
      await room.getByText(/^Deal watch settings/).click();
      const watch = room.getByRole("group", { name: "Watch settings" });
      const checkboxes = watch.getByRole("checkbox");
      await expect(checkboxes).toHaveCount(3);
      for (const checkbox of await checkboxes.all()) await expect(checkbox).toBeEnabled();
      const labels = watch.locator("label").filter({ has: page.getByRole("checkbox") });
      await expectTouchTargets(labels);
      for (const [index, label] of (await labels.all()).entries()) {
        const checkbox = checkboxes.nth(index);
        const checked = await checkbox.isChecked();
        await label.tap({ position: { x: 2, y: 2 } });
        await expect(checkbox).toBeChecked({ checked: !checked });
      }
    });

    test("Home card selection and bottom navigation work on phones", async ({ page }) => {
      await page.clock.setFixedTime(new Date("2026-11-05T18:00:00Z"));
      await page.goto(server.url);
      const cards = page.getByRole("region", { name: "Reminders", exact: true });
      const checkbox = cards.getByRole("checkbox", { name: /^Select / }).first();
      await expect(checkbox).toBeEnabled();
      const label = cards
        .locator("label")
        .filter({ has: page.getByRole("checkbox", { name: /^Select / }) })
        .first();
      const target = await label.boundingBox();
      assert.ok(target);
      expect(target.width).toBeGreaterThanOrEqual(44);
      expect(target.height).toBeGreaterThanOrEqual(44);
      await label.tap({ position: { x: 2, y: 2 } });
      await expect(checkbox).toBeChecked();
      const navLabels = page.locator("#appShell .app-shell-navigation .app-shell-nav-label:visible");
      const sizes = await navLabels.evaluateAll((nodes) =>
        nodes.map((node) => parseFloat(getComputedStyle(node).fontSize)),
      );
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.every((size) => size >= 12)).toBe(true);
    });
  });
}
