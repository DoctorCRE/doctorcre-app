import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Page, Request, Route } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import anniversaryRecording from "./fixtures/client-anniversary-panel/recordings.json" with { type: "json" };

const emptyFeed = { unread_count: 0, updates: [] };
const preferences = {
  time_zone: "America/Chicago",
  quiet_from: null,
  quiet_until: null,
  push_to_device: false,
  base_version: 0,
};
const legacyPreferences = {
  ok: true,
  version: 1,
  exists: false,
  device_opt_in: false,
  timezone: "UTC",
  quiet_hours_start: null,
  quiet_hours_end: null,
};
const deal = "11111111-1111-4111-8111-111111111111";
const unread = {
  source_id: "22222222-2222-4222-8222-222222222222",
  title: "Example Dental checklist item is due",
  why: "Send the lease draft · Due Nov 24",
  primary_action: "Open checklist item",
  kind_label: "Update",
  open_url: `/deals?deal=${deal}`,
  activity_at: "2026-11-20T15:00:00Z",
  read_at: null,
  unseen: true,
};
const property = "44444444-4444-4444-8444-444444444444";
const seen = {
  ...unread,
  source_id: "33333333-3333-4333-8333-333333333333",
  title: "Tour feedback on Example Plaza",
  why: "Liked the parking",
  primary_action: "Review feedback",
  kind_label: "Tour feedback",
  open_url: `/deals?deal=${deal}&property=${property}`,
  read_at: "2026-11-20T16:00:00Z",
  unseen: false,
};
const change = (who: string, what: string) => ({
  id: `${who}-${what}`,
  changed_at: "2026-11-20T15:00:00Z",
  who,
  record: "Example Dental",
  what,
  open_url: `/deals?deal=${deal}`,
});
const screenshotDir = process.env.UPDATES_SCREENSHOT_DIR;
const viewports = [390, 1440];
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

type Handler = (request: Request) => Reply | Promise<Reply>;

async function open(
  t: TestContext,
  width: number,
  theme: string,
  engine: Record<string, Handler> = {},
  fromEngine = true,
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
  const verbs: string[] = [];
  await page.route("**/mcp", (route) => {
    const verb = route.request().postDataJSON().params.name;
    verbs.push(verb);
    const output = verb === "notification-feed" ? { unread_count: 0, notifications: [] } : legacyPreferences;
    return route.fulfill({ json: { result: { content: [{ type: "text", text: JSON.stringify(output) }] } } });
  });
  await page.route("**/pipeline/changes", (route) => {
    verbs.push("/pipeline/changes");
    return route.fulfill({ json: { events: [], cursor: "end" } });
  });
  let saved = preferences;
  const defaults: Record<string, Handler> = {
    "GET /api/engine/updates": () => ({ json: emptyFeed }),
    "GET /api/engine/preferences": () => ({ json: saved }),
    "POST /api/engine/preferences": (request) => {
      const { idempotency_key: _key, ...fields } = request.postDataJSON();
      saved = { ...fields, base_version: saved.base_version + 1 };
      return { json: { ok: true, ...saved } };
    },
    "GET /api/engine/updates/changes": () => ({ json: { changes: [], next_before: null } }),
  };
  const sent: { key: string; search: string; body: Record<string, unknown> | null }[] = [];
  await page.route("**/api/engine/**", async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const key = `${request.method()} ${url.pathname}`;
    sent.push({ key, search: url.search, body: request.postDataJSON() });
    const handler = engine[key] ?? defaults[key];
    return route.fulfill(handler ? await handler(request) : { status: 404, json: { error: "not_found" } });
  });
  const updatesPage = assets.get("/notifications.html")?.body;
  assert.ok(updatesPage);
  await page.route(/^https?:\/\/[^/]+\/updates(?:\?|$)/, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: fromEngine ? updatesPage.toString().replace("<html ", "<html data-deals-saves-from-engine ") : updatesPage,
    }),
  );
  return { page, sent, verbs };
}

async function assertListOnly(page: Page) {
  assert.doesNotMatch((await page.locator("main").textContent()) ?? "", explainers);
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
      const { page } = await open(t, width, theme, { "GET /api/engine/updates": () => pending.promise });
      t.after(() => pending.resolve({ json: emptyFeed }));
      await page.goto(updates);
      await page.getByRole("heading", { name: "Loading notifications…" }).waitFor();
      assert.equal(await page.getByRole("heading", { level: 1, name: "Updates" }).isVisible(), true);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      await assertListOnly(page);
      await capture(page, "updates-loading", width, theme);
      pending.resolve({ json: emptyFeed });
      await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
    });

    test(`a failed Updates read can recover via Retry at ${width}px in ${theme} mode`, async (t) => {
      const recovered = Promise.withResolvers<Reply>();
      // The nav badge reads the same route, so the failure lasts until Retry.
      let failing = true;
      const { page } = await open(t, width, theme, {
        "GET /api/engine/updates": () => (failing ? { status: 503, json: {} } : recovered.promise),
      });
      t.after(() => recovered.resolve({ json: emptyFeed }));
      await page.goto(updates);
      await page.getByRole("heading", { name: "Couldn't load updates", exact: true }).waitFor();
      const retry = page.getByRole("button", { name: "Retry", exact: true });
      await retry.waitFor({ timeout: 2500 });
      assert.equal(await retry.textContent(), "Retry");
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-unavailable", width, theme);
      failing = false;
      await retry.click();
      await page.getByRole("heading", { name: "Loading notifications…" }).waitFor();
      recovered.resolve({ json: { unread_count: 1, updates: [unread] } });
      await page.getByRole("heading", { name: unread.title }).waitFor();
      assert.equal(await retry.count(), 0);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-recovered", width, theme);
    });

    test(`an empty Updates read shows No updates at ${width}px in ${theme} mode`, async (t) => {
      const { page } = await open(t, width, theme);
      await page.clock.setFixedTime(new Date("2026-07-01T12:27:00Z"));
      await page.goto(updates);
      await page.getByRole("heading", { name: "No updates", exact: true }).waitFor({ timeout: 2500 });
      assert.equal(await page.locator("#feedAsOf").textContent(), "As of 7:27 AM CDT");
      assert.equal(await page.getByText("Nothing unread", { exact: true }).count(), 1);
      assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).count(), 0);
      assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /\bunknown\b/i);
      await assertListOnly(page);
      await capture(page, "updates-empty", width, theme);
    });

    for (const entry of ["More", "old bookmark"]) {
      test(`Closing anniversaries heading and title agree from ${entry} at ${width}px in ${theme} mode`, async (t) => {
        const { page } = await open(t, width, theme);
        await page.route("**/api/v1/intelligence/client-anniversary-read?**", (route) =>
          route.fulfill({ json: anniversaryRecording.ready.output }),
        );
        if (entry === "More") {
          await page.goto(server.origin);
          await page.getByRole("button", { name: "More", exact: true }).click();
          await page.getByRole("link", { name: "Closing anniversaries", exact: true }).click();
        } else {
          await page.goto(`${server.origin}/leases?mode=live&lease=old&quarter=2027-Q1`);
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
  const { page } = await open(t, 390, "dark", { "GET /api/engine/updates": () => ({ json: {} }) });
  await page.goto(`${server.origin}/updates?mode=live`);
  await page.getByRole("heading", { name: "Couldn't load updates", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
});

test("saving notification preferences keeps its confirmation separate from a pending feed refresh", async (t) => {
  const refreshed = Promise.withResolvers<Reply>();
  let saved = false;
  const { page } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => (saved ? refreshed.promise : { json: emptyFeed }),
    "POST /api/engine/preferences": (request) => {
      saved = true;
      const { idempotency_key: _key, ...fields } = request.postDataJSON();
      return { json: { ok: true, ...fields, base_version: 1 } };
    },
  });
  t.after(() => refreshed.resolve({ json: emptyFeed }));
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

  refreshed.resolve({ json: emptyFeed });
  await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
  assert.equal(await confirmation.count(), 1);
});

const updatesPath = `${server.origin}/updates?mode=live`;
const saveButton = (page: Page) => page.getByRole("button", { name: "Save preferences" });
const savedFields = (sent: { key: string; body: Record<string, unknown> | null }[]) =>
  sent
    .filter(({ key }) => key === "POST /api/engine/preferences")
    .map(({ body }) => {
      const { idempotency_key: _key, ...fields } = body ?? {};
      return fields;
    });

test("Updates lists the partner's engine updates with the unread count", async (t) => {
  const { page, sent, verbs } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 1, updates: [unread, seen, seen] } }),
  });
  await page.addInitScript(() => {
    if (location.pathname === "/updates") history.replaceState(null, "", "/updates?mode=live");
  });
  await page.goto(server.origin);
  await page.getByRole("button", { name: "More", exact: true }).click();
  sent.length = 0;
  verbs.length = 0;
  await page.getByRole("link", { name: "Updates", exact: true }).click();
  await page.getByRole("heading", { name: unread.title }).waitFor({ timeout: 2500 });
  assert.equal(await page.locator("#unreadLine").textContent(), "1 unread notification");
  assert.equal(await page.getByText(unread.why, { exact: true }).count(), 1);
  const open_ = page.getByRole("link", { name: "Open checklist item" });
  assert.equal(await open_.getAttribute("href"), unread.open_url);
  assert.equal(await page.getByRole("heading", { name: seen.title }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Review feedback" }).getAttribute("href"), seen.open_url);
  await page.locator("#prefForm").waitFor();
  await page.getByText("No recent activity", { exact: true }).waitFor();
  assert.deepEqual(sent.map(({ key }) => key).sort(), [
    "GET /api/engine/preferences",
    "GET /api/engine/updates",
    "GET /api/engine/updates/changes",
  ]);
  assert.deepEqual(verbs, []);
  const unreadCard = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: unread.title }) });
  assert.equal(await unreadCard.getByText("9:00 AM CST", { exact: true }).count(), 1);
  assert.equal(await unreadCard.getByText("Unread", { exact: true }).count(), 1);
  assert.equal(await page.getByText("Read at 10:00 AM CST", { exact: true }).count(), 1);
  const today = page.waitForRequest("**/api/engine/home/today");
  await page.getByRole("button", { name: "Today sidebar" }).click();
  await today;
});

test("opening an unread update uses the saved read time and returned badge count", async (t) => {
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 3, updates: [unread] } }),
    "POST /api/engine/updates/read": () => ({
      json: { ok: true, updates: [{ id: unread.source_id, read_at: "2026-11-21T12:00:00Z" }], unread_count: 2 },
    }),
  });
  await page.goto(updatesPath);
  await page.getByRole("button", { name: "Mark shown as read" }).waitFor({ timeout: 2500 });
  const opened = page.waitForEvent("popup");
  await page.getByRole("link", { name: "Open checklist item" }).click();
  assert.equal(new URL((await opened).url()).searchParams.get("deal"), deal);
  await page.getByText("Read at 6:00 AM CST", { exact: true }).waitFor();
  assert.equal(await page.locator("#navUnreadBadge").getAttribute("aria-label"), "2 unread notifications");
  const [save] = sent.filter(({ key }) => key === "POST /api/engine/updates/read");
  assert.deepEqual(save?.body?.update_ids, [unread.source_id]);
  assert.match(String(save?.body?.idempotency_key), /^[0-9a-f-]{36}$/);
});

test("Mark all read reuses the key after an unanswered save", async (t) => {
  const second = { ...seen, read_at: null, unseen: true };
  let attempts = 0;
  const updates = [unread, second].map(({ source_id: id }) => ({ id, read_at: "2026-11-21T12:00:00Z" }));
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 2, updates: [unread, second] } }),
    "POST /api/engine/updates/read": () =>
      ++attempts === 1
        ? { status: 503, json: { error: "unavailable" } }
        : { json: { ok: true, unread_count: 0, updates } },
  });
  await page.goto(updatesPath);
  await page.getByRole("button", { name: "Mark all read", exact: true }).click({ timeout: 2500 });
  await page.getByRole("button", { name: "Check outcome" }).click();
  await page.locator("#unreadLine").getByText("Nothing unread", { exact: true }).waitFor();
  const writes = sent.filter(({ key }) => key === "POST /api/engine/updates/read").map(({ body }) => body);
  assert.equal(writes.length, 2);
  assert.deepEqual(writes[0]?.update_ids, [unread.source_id, second.source_id]);
  assert.deepEqual(writes[1], writes[0]);
});

test("checking a read outcome keeps the badge from counting an already read update", async (t) => {
  const firstReadAt = "2026-11-21T12:00:00Z";
  const secondReadAt = "2026-11-21T13:00:00Z";
  const second = { ...seen, read_at: null, unseen: true };
  let firstSaved = false;
  let secondSaved = false;
  const { page } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({
      json: {
        unread_count: 2 - Number(firstSaved) - Number(secondSaved),
        updates: [
          { ...unread, read_at: firstSaved ? firstReadAt : null },
          { ...second, read_at: secondSaved ? secondReadAt : null },
        ],
      },
    }),
    "POST /api/engine/updates/read": (request) => {
      const [id] = request.postDataJSON().update_ids;
      if (id === second.source_id) {
        secondSaved = true;
        return { json: { ok: true, unread_count: 0, updates: [{ id, read_at: secondReadAt }] } };
      }
      if (firstSaved) {
        return { json: { ok: true, replayed: true, unread_count: 1, updates: [{ id, read_at: firstReadAt }] } };
      }
      firstSaved = true;
      return { status: 503, json: { error: "unavailable" } };
    },
  });
  await page.goto(updatesPath);
  await page.getByRole("link", { name: unread.primary_action }).click();
  const check = page.getByRole("button", { name: "Check outcome" });
  await check.waitFor();
  await page.getByRole("link", { name: second.primary_action }).press("Enter");
  await page.getByText("Read at 7:00 AM CST", { exact: true }).waitFor();
  const badge = page.locator("#navUnreadBadge");
  assert.equal(await badge.getAttribute("aria-label"), null);

  await check.click();
  await page.getByText("Read at 6:00 AM CST", { exact: true }).waitFor();
  assert.equal(await page.getByText("Read at 7:00 AM CST", { exact: true }).count(), 1);
  assert.equal(await badge.getAttribute("aria-label"), null);
});

test("a missing update reloads the feed and badge", async (t) => {
  let missing = false;
  const { page } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({ json: missing ? emptyFeed : { unread_count: 1, updates: [unread] } }),
    "POST /api/engine/updates/read": () => {
      missing = true;
      return { status: 404, json: { error: "not_found" } };
    },
  });
  await page.goto(updatesPath);
  await page.getByRole("button", { name: "Mark all read", exact: true }).click({ timeout: 2500 });
  await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
  assert.equal(await page.locator("#navUnreadBadge").getAttribute("aria-label"), null);
});

test("notification settings load the engine defaults and save all four fields", async (t) => {
  const { page, sent } = await open(t, 390, "dark");
  await page.goto(updatesPath);
  await page.locator("#prefForm").waitFor();
  assert.equal(await page.locator("#quietTimezone").inputValue(), "America/Chicago");
  assert.equal(await page.locator("#quietStart").inputValue(), "");
  assert.equal(await page.locator("#deviceOptIn").isChecked(), false);
  assert.equal(
    await page.locator("#prefSummary").textContent(),
    "No quiet hours set · America/Chicago · device push off",
  );
  await page.locator("#quietStart").fill("10:00 PM");
  await page.locator("#quietEnd").fill("7:00 AM");
  await page.locator("#deviceOptIn").check();
  await saveButton(page).click();
  await page.locator("#prefMessage").getByText("Saved", { exact: true }).waitFor();
  assert.deepEqual(savedFields(sent), [
    { base_version: 0, time_zone: "America/Chicago", quiet_from: "22:00", quiet_until: "07:00", push_to_device: true },
  ]);
  await page
    .locator("#prefSummary")
    .getByText("Quiet hours 10:00 PM to 7:00 AM America/Chicago · device push on")
    .waitFor();
});

test("checking a settings save outcome keeps newer preferences on screen", async (t) => {
  const saved = { ...preferences, time_zone: "America/Denver", base_version: 5 };
  const newer = { ...preferences, time_zone: "America/New_York", base_version: 6 };
  let current = { ...preferences, base_version: 4 };
  let savedOnce = false;
  const { page } = await open(t, 390, "dark", {
    "GET /api/engine/preferences": () => ({ json: current }),
    "POST /api/engine/preferences": () => {
      if (savedOnce) return { json: { ok: true, replayed: true, ...saved } };
      savedOnce = true;
      current = saved;
      return { status: 503, json: { error: "unavailable" } };
    },
  });
  await page.goto(updatesPath);
  const timeZone = page.getByLabel("Timezone");
  await timeZone.fill(saved.time_zone);
  await saveButton(page).click();
  const check = page.locator("#prefForm").getByRole("button", { name: "Check outcome" });
  await check.waitFor();
  current = newer;
  await page.getByRole("button", { name: "Refresh", exact: true }).press("Enter");
  const summary = page.locator("#prefSummary");
  await summary.getByText(/America\/New_York/).waitFor();

  await check.press("Enter");
  await saveButton(page).waitFor();
  assert.equal(await timeZone.inputValue(), newer.time_zone);
  assert.match(await summary.textContent() ?? "", /America\/New_York/);
});

test("notification settings explain a refused time zone and an unpaired quiet hour", async (t) => {
  const { page, sent } = await open(t, 390, "dark", {
    "POST /api/engine/preferences": () => ({
      status: 400,
      json: { error: "invalid_field_value", fields: ["time_zone"] },
    }),
  });
  await page.goto(updatesPath);
  await page.locator("#prefForm").waitFor();
  await page.locator("#quietStart").fill("10:00 PM");
  await saveButton(page).click();
  await page
    .locator("#prefMessage")
    .getByText(/start and an end that differ/)
    .waitFor();
  assert.equal(savedFields(sent).length, 0);
  await page.locator("#quietStart").fill("");
  await page.locator("#quietTimezone").fill("Example/Nowhere");
  await saveButton(page).click();
  await page.locator("#prefMessage").getByText("Timezone unavailable. Preferences were not saved.").waitFor();
  assert.equal(savedFields(sent)[0]?.time_zone, "Example/Nowhere");
  assert.equal(await page.getByLabel("Timezone").getAttribute("aria-invalid"), "true");
  assert.equal(await page.getByLabel("Quiet hours start").getAttribute("aria-invalid"), null);
});

test("a settings save that crossed another change reloads and says so", async (t) => {
  let conflicted = false;
  const { page } = await open(t, 390, "dark", {
    "POST /api/engine/preferences": () => {
      conflicted = true;
      return { status: 409, json: { error: "version_conflict", current_version: 9 } };
    },
    "GET /api/engine/preferences": () => ({
      json: conflicted ? { ...preferences, push_to_device: true, base_version: 9 } : preferences,
    }),
  });
  await page.goto(updatesPath);
  await page.locator("#prefForm").waitFor();
  await page.locator("#quietTimezone").fill("America/Denver");
  await saveButton(page).click();
  await page
    .locator("#prefMessage")
    .getByText(/^Preferences changed elsewhere\. Your changes were not saved\./)
    .waitFor();
  await page.locator("#prefSummary").getByText("No quiet hours set · America/Chicago · device push on").waitFor();
  assert.equal(
    await page
      .locator("#prefForm")
      .getByText(/Version 9/)
      .count(),
    0,
  );
});

test("Who did what shows the engine's first page and Show more follows next_before", async (t) => {
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates/changes": (request) => ({
      json:
        new URL(request.url()).searchParams.get("before") === "cursor-1"
          ? { changes: [change("Blair Example", "added a note")], next_before: null }
          : { changes: [change("Alex Example", "moved the deal to LOI")], next_before: "cursor-1" },
    }),
  });
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: "Alex Example · moved the deal to LOI" }).waitFor();
  assert.equal(
    await page.locator("#activityList").getByText("Example Dental · 9:00 AM CST", { exact: true }).count(),
    1,
  );
  assert.equal(
    await page.locator("#activityList").getByRole("link", { name: "Open deal" }).getAttribute("href"),
    `/deals?deal=${deal}`,
  );
  await page.getByRole("button", { name: "Show more" }).click();
  await page.getByRole("heading", { name: "Blair Example · added a note" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Alex Example · moved the deal to LOI" }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Show more" }).isVisible(), false);
  assert.deepEqual(
    sent.filter(({ key }) => key === "GET /api/engine/updates/changes").map(({ search }) => search),
    ["", "?before=cursor-1"],
  );
});

test("a rejected activity cursor can be reloaded from the first page", async (t) => {
  const before = "next+page/==";
  let failed = false;
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates/changes": (request) => {
      if (new URL(request.url()).searchParams.get("before") === before) {
        failed = true;
        return { status: 400, json: { error: "invalid_field_value", fields: ["before"] } };
      }
      return { json: { changes: [change("Alex Example", "opened the deal")], next_before: failed ? null : before } };
    },
  });
  await page.goto(updatesPath);
  await page.getByRole("button", { name: "Show more" }).click();
  await page.getByRole("button", { name: "Reload activity" }).click({ timeout: 2500 });
  await page.getByRole("heading", { name: "Alex Example · opened the deal" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Show more" }).isVisible(), false);
  assert.deepEqual(
    sent.filter(({ key }) => key.endsWith("/changes")).map(({ search }) => search),
    ["", `?before=${encodeURIComponent(before)}`, ""],
  );
});

test("switch off keeps the old feed, settings and activity reads", async (t) => {
  const { page, sent, verbs } = await open(t, 390, "dark", {}, false);
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: "No updates", exact: true }).waitFor();
  await page.locator("#prefForm").waitFor();
  await page.getByText("No recent activity", { exact: true }).waitFor();
  assert.equal(await page.getByLabel("Timezone").inputValue(), "UTC");
  assert.ok(verbs.includes("notification-feed"));
  assert.ok(verbs.includes("read-notification-preferences"));
  assert.ok(verbs.includes("/pipeline/changes"));
  assert.ok(sent.every(({ key }) => key === "GET /api/engine/home/today"));
});

test("a conflict keeps the settings draft and notice visible when the refresh fails", async (t) => {
  let conflicted = false;
  let available = false;
  const { page } = await open(t, 390, "dark", {
    "POST /api/engine/preferences": () => {
      conflicted = true;
      return { status: 409, json: { error: "version_conflict", current_version: 9 } };
    },
    "GET /api/engine/preferences": () => {
      if (!conflicted) return { json: preferences };
      return available
        ? { json: { ...preferences, base_version: 9 } }
        : { status: 503, json: { error: "unavailable" } };
    },
  });
  await page.goto(updatesPath);
  const draft = page.getByLabel("Timezone");
  await draft.fill("America/Denver");
  await saveButton(page).click();
  const panel = page.getByRole("region", { name: "Your notification preferences" });
  await panel.locator('#prefState[data-state="unavailable"]').waitFor();
  assert.equal(await draft.isVisible(), true, "the unsaved timezone remains visible");
  assert.equal(await draft.inputValue(), "America/Denver");
  const notice = panel
    .getByRole("status")
    .filter({ hasText: /^Preferences changed elsewhere\. Your changes were not saved\./ });
  await notice.waitFor();

  available = true;
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await panel
    .locator("#prefSummary")
    .getByText(/America\/Chicago/)
    .waitFor();
  assert.equal(await draft.inputValue(), "America/Denver");
  assert.equal(await notice.isVisible(), true);
});

test("automatic refresh fills in new activity and keeps the loaded rows and Show more", async (t) => {
  let refreshed = false;
  const { page } = await open(t, 390, "dark", {
    "GET /api/engine/updates/changes": (request) => {
      const before = new URL(request.url()).searchParams.get("before");
      if (before === "new-page") {
        return {
          json: {
            changes: [change("Alex Example", "sent the draft"), change("Alex Example", "opened the deal")],
            next_before: "second",
          },
        };
      }
      if (before === "second") {
        return { json: { changes: [change("Blair Example", "added a note")], next_before: "third" } };
      }
      if (before === "third") {
        return { json: { changes: [change("Blair Example", "added the lead")], next_before: null } };
      }
      return {
        json: refreshed
          ? { changes: [change("Alex Example", "signed the lease")], next_before: "new-page" }
          : { changes: [change("Alex Example", "opened the deal")], next_before: "second" },
      };
    },
  });
  await page.clock.install({ time: new Date("2026-11-21T12:00:00Z") });
  await page.goto(updatesPath);
  const more = page.getByRole("button", { name: "Show more" });
  const rows = page.locator("#activityList").getByRole("heading");
  await more.click();
  await rows.getByText("Blair Example · added a note").waitFor();
  refreshed = true;
  await page.clock.fastForward(60_000);
  await rows.getByText("Alex Example · signed the lease").waitFor({ timeout: 5_000 });
  const expected = [
    "Alex Example · signed the lease",
    "Alex Example · sent the draft",
    "Alex Example · opened the deal",
    "Blair Example · added a note",
  ];
  assert.deepEqual(await rows.allTextContents(), expected);
  await more.click();
  await rows.getByText("Blair Example · added the lead").waitFor();
  assert.deepEqual(await rows.allTextContents(), [...expected, "Blair Example · added the lead"]);
  assert.equal(await more.isVisible(), false);
});
