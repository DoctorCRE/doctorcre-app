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
const seen = {
  ...unread,
  source_id: "33333333-3333-4333-8333-333333333333",
  title: "Tour feedback on Example Plaza",
  why: "Liked the parking",
  primary_action: "Review feedback",
  kind_label: "Tour feedback",
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

type Handler = (request: Request) => Reply | Promise<Reply>;

async function open(t: TestContext, width: number, theme: string, engine: Record<string, Handler> = {}) {
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
    verbs.push(route.request().postDataJSON()?.params?.name);
    return route.fulfill({ json: { result: { content: [{ type: "text", text: "{}" }] } } });
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
  await page.route(`${server.origin}/updates?**`, (route) =>
    route.fulfill({
      contentType: "text/html",
      body: updatesPage.toString().replace("<html ", "<html data-deals-saves-from-engine "),
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
        const { page } = await open(t, width, theme);
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
  const { page, verbs } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 1, updates: [unread, seen] } }),
  });
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: unread.title }).waitFor();
  assert.equal(await page.locator("#unreadLine").textContent(), "1 unread notification");
  assert.equal(await page.getByText(unread.why, { exact: true }).count(), 1);
  const open_ = page.getByRole("link", { name: "Open checklist item" });
  assert.equal(await open_.getAttribute("href"), unread.open_url);
  assert.equal(await page.getByRole("heading", { name: seen.title }).count(), 1);
  assert.equal(await page.getByRole("button", { name: "Acknowledge this notification" }).count(), 1);
  assert.equal(verbs.filter((verb) => /notification/.test(verb)).length, 0);
});

test("marking an update read saves it to the engine and refreshes the count", async (t) => {
  let marked = false;
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({
      json: marked
        ? { unread_count: 0, updates: [{ ...unread, read_at: "2026-11-21T12:00:00Z", unseen: false }] }
        : { unread_count: 1, updates: [unread] },
    }),
    "POST /api/engine/updates/read": () => {
      marked = true;
      return {
        json: { ok: true, updates: [{ id: unread.source_id, read_at: "2026-11-21T12:00:00Z" }], unread_count: 0 },
      };
    },
  });
  await page.goto(updatesPath);
  const badge = page.locator("#navUnreadBadge");
  await page.locator('#navUnreadBadge[aria-label="1 unread notification"]').waitFor({ state: "attached" });
  await page.getByRole("button", { name: "Acknowledge this notification" }).click();
  await page.locator("#unreadLine").getByText("Nothing unread", { exact: true }).waitFor();
  assert.equal(await badge.getAttribute("aria-label"), null);
  assert.equal(await badge.getAttribute("hidden"), "");
  assert.equal(sent.filter(({ key }) => key === "GET /api/engine/updates").length, 2);
  const [save] = sent.filter(({ key }) => key === "POST /api/engine/updates/read");
  assert.deepEqual(save?.body?.update_ids, [unread.source_id]);
  assert.match(String(save?.body?.idempotency_key), /^[0-9a-f-]{36}$/);
  assert.equal(await page.getByRole("button", { name: "Acknowledge this notification" }).count(), 0);
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
  assert.equal(await page.locator("#prefVersion").textContent(), "Version 9");
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
