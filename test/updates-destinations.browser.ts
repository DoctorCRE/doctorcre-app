import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Page, Route } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import anniversaryRecording from "./fixtures/client-anniversary-panel/recordings.json" with { type: "json" };

const emptyFeed = { unread_count: 0, notifications: [] };
const preferences = {
  ok: true,
  exists: false,
  version: 1,
  device_opt_in: false,
  quiet_hours_start: null,
  quiet_hours_end: null,
  timezone: "UTC",
};
const rpc = (payload: object) => ({ result: { content: [{ type: "text", text: JSON.stringify(payload) }] } });
const screenshotDir = process.env.UPDATES_SCREENSHOT_DIR;
const viewports = screenshotDir ? [390, 1440] : [390];
const themes = screenshotDir ? ["light", "dark"] : ["dark"];

const explainers =
  /Addressed to you|Accountable activity|shown here yet|About updates|Quiet hours hold|Preferences saved|Quiet hours off · Push off/;

const assets = await appAssetSnapshot();
const server = await startWorkerFixture({
  routes: assets,
  demo: true,
  env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response(null) } },
});
test.after(() => server.close());

type Reply = NonNullable<Parameters<Route["fulfill"]>[0]>;

async function open(
  t: TestContext,
  width: number,
  theme: string,
  readFeed: () => Reply | Promise<Reply> = () => ({ json: rpc(emptyFeed) }),
) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme, walkthroughSeen: { joe: true } }));
  }, theme);
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route("**/pipeline/changes", (route) => route.fulfill({ json: { cursor: "", events: [] } }));
  let savedPreferences = preferences;
  await page.route("**/mcp", async (route) => {
    const request: { params: { name: string; arguments: { limit?: number } } } = route.request().postDataJSON();
    const { name, arguments: args } = request.params;
    if (name === "notification-feed" && args.limit === 25) return route.fulfill(await readFeed());
    if (name === "set-notification-preference") {
      savedPreferences = { ...preferences, exists: true, device_opt_in: true, version: 2 };
      return route.fulfill({ json: rpc(savedPreferences) });
    }
    const payload = name === "read-notification-preferences" ? savedPreferences : emptyFeed;
    return route.fulfill({ json: rpc(payload) });
  });
  const updatesPage = assets.get("/notifications.html")?.body;
  assert.ok(updatesPage);
  await page.route(`${server.origin}/updates?**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: updatesPage.toString().replace("<html ", "<html data-deals-saves-from-engine "),
    }),
  );
  return page;
}

async function assertListOnly(page: Page) {
  const main = page.locator("main");
  assert.doesNotMatch((await main.textContent()) ?? "", explainers);
  assert.equal(await main.getByRole("heading", { name: "Who did what" }).count(), 0);
}

async function capture(page: Page, name: string, width: number, theme: string) {
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  await page.screenshot({ path: join(screenshotDir, `${name}-${width}-${theme}.png`) });
}

for (const width of viewports)
  for (const theme of themes) {
    const updates = `${server.origin}/updates?mode=live`;

    test(`Updates shows loading without a placeholder at ${width}px in ${theme} mode`, async (t) => {
      const pending = Promise.withResolvers<Reply>();
      const page = await open(t, width, theme, () => pending.promise);
      t.after(() => pending.resolve({ json: rpc(emptyFeed) }));
      await page.goto(updates);
      await page.getByRole("heading", { name: "Loading notifications…" }).waitFor();
      assert.equal(await page.getByRole("heading", { level: 1, name: "Updates" }).isVisible(), true);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      await assertListOnly(page);
      await capture(page, "updates-loading", width, theme);
      pending.resolve({ json: rpc(emptyFeed) });
      await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
    });

    test(`a failed Updates read can recover via Retry at ${width}px in ${theme} mode`, async (t) => {
      const recovered = Promise.withResolvers<Reply>();
      let reads = 0;
      const page = await open(t, width, theme, () => {
        reads++;
        return reads === 1 ? { status: 503, json: {} } : recovered.promise;
      });
      t.after(() => recovered.resolve({ json: rpc(emptyFeed) }));
      await page.goto(updates);
      await page.getByRole("heading", { name: "Couldn't load updates", exact: true }).waitFor();
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor({ timeout: 2500 });
      assert.equal(await retry.textContent(), "Retry");
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-unavailable", width, theme);
      await retry.click();
      await page.getByRole("heading", { name: "Loading notifications…" }).waitFor();
      recovered.resolve({
        json: rpc({
          unread_count: 1,
          notifications: [
            { id: "synthetic-notification", severity: "action_required", reason: "Review a synthetic update" },
          ],
        }),
      });
      await page.getByRole("heading", { name: "Review a synthetic update" }).waitFor();
      assert.equal(reads, 2);
      assert.equal(await retry.count(), 0);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-recovered", width, theme);
    });

    test(`an empty Updates read shows No updates at ${width}px in ${theme} mode`, async (t) => {
      const page = await open(t, width, theme);
      await page.goto(updates);
      await page.getByRole("heading", { name: "No updates", exact: true }).waitFor({ timeout: 2500 });
      assert.equal(await page.getByText("Nothing unread", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-empty", width, theme);
    });

    for (const entry of ["More", "direct visit"]) {
      test(`Closing anniversaries heading and title agree from ${entry} at ${width}px in ${theme} mode`, async (t) => {
        const page = await open(t, width, theme);
        for (const [path, asset] of Object.entries({
          "/": "/workspace.html",
          "/leases": "/lease-anniversaries.html",
        })) {
          const body = assets.get(asset)?.body;
          assert.ok(body);
          await page.route(server.origin + path, (route) =>
            route.fulfill({
              contentType: "text/html",
              body: body.toString().replace("<html ", "<html data-deals-saves-from-engine "),
            }),
          );
        }
        await page.route("**/api/v1/intelligence/client-anniversary-read?**", (route) =>
          route.fulfill({ json: anniversaryRecording.ready.output }),
        );
        if (entry === "More") {
          await page.goto(server.origin);
          await page.getByRole("button", { name: "More", exact: true }).click();
          await page.getByRole("link", { name: "Closing anniversaries", exact: true }).click();
        } else {
          await page.goto(`${server.origin}/leases`);
        }
        await page.locator("#clientAnniversaries ol li").first().waitFor();
        assert.equal(new URL(page.url()).pathname, "/leases");
        assert.equal(await page.title(), "Closing anniversaries · DoctorCRE");
        assert.equal(await page.getByRole("heading", { level: 1 }).textContent(), "Closing anniversaries");
        assert.equal(
          await page.locator("#main").getByRole("heading", { name: "Closing anniversaries", exact: true }).count(),
          1,
        );
        assert.equal(
          await page.locator("#main").getByRole("link", { name: "Deals", exact: true }).getAttribute("href"),
          "/deals",
        );
        if (entry === "More") await capture(page, "closing-anniversaries", width, theme);
      });
    }
  }

test("an invalid feed reply offers Retry instead of staying in loading", async (t) => {
  const page = await open(t, 390, "dark", () => ({ json: rpc({}) }));
  await page.goto(`${server.origin}/updates?mode=live`);
  await page.getByRole("heading", { name: "Couldn't load updates", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
});

test("saving notification preferences keeps its confirmation separate from a pending feed refresh", async (t) => {
  const refreshed = Promise.withResolvers<Reply>();
  let firstRead = true;
  const page = await open(t, 390, "dark", () => {
    if (!firstRead) return refreshed.promise;
    firstRead = false;
    return { json: rpc(emptyFeed) };
  });
  t.after(() => refreshed.resolve({ json: rpc(emptyFeed) }));
  await page.goto(`${server.origin}/updates?mode=live`);
  await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();

  const feedStatus = page.getByRole("status").filter({ hasText: /^No updates$/ });
  const announcements = await feedStatus.evaluateHandle((region) => {
    const messages: string[] = [];
    new MutationObserver((changes) => {
      for (const change of changes) {
        for (const node of change.addedNodes) messages.push(node.textContent ?? "");
      }
    }).observe(region, { childList: true });
    return messages;
  });

  await page.getByRole("checkbox", { name: "Send a device push when something is addressed to me" }).check();
  await page.getByRole("button", { name: "Save preferences" }).click();
  await page
    .getByRole("status")
    .filter({ hasText: /^Updating…$/ })
    .waitFor();
  const confirmation = page.getByRole("status").filter({ hasText: /^Saved$/ });
  assert.equal(await confirmation.count(), 1);
  assert.deepEqual(await announcements.jsonValue(), ["Updating…"]);

  refreshed.resolve({ json: rpc(emptyFeed) });
  await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
  assert.equal(await confirmation.count(), 1);
});
