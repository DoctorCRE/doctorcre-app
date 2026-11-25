import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import type { Locator, Page, Request, Route } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import anniversaryRecording from "./fixtures/client-anniversary-panel/recordings.json" with { type: "json" };

const emptyFeed = { unread_count: 0, updates: [] };
type Preferences = {
  time_zone: string;
  quiet_from: string | null;
  quiet_until: string | null;
  push_to_device: boolean;
  base_version: number;
};
const preferences: Preferences = {
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

function preferenceStore(initial: Preferences): Record<string, Handler> {
  let saved = initial;
  return {
    "GET /api/engine/preferences": () => ({ json: saved }),
    "POST /api/engine/preferences": (request) => {
      const { idempotency_key: _key, ...fields } = request.postDataJSON();
      saved = { ...fields, base_version: saved.base_version + 1 };
      return { json: { ok: true, ...saved } };
    },
  };
}

async function open(
  t: TestContext,
  width: number,
  theme: string,
  engine: Record<string, Handler> = {},
  fromEngine = true,
  height = width === 390 ? 844 : 1000,
) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
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
  const defaults: Record<string, Handler> = {
    "GET /api/engine/updates": () => ({ json: emptyFeed }),
    ...preferenceStore(preferences),
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
  for (const [path, asset] of [
    ["updates", "/notifications.html"],
    ["settings", "/settings.html"],
  ] as const) {
    const body = assets.get(asset)?.body;
    assert.ok(body);
    await page.route(new RegExp(`^https?://[^/]+/${path}(?:\\?|$)`), (route) =>
      route.fulfill({
        contentType: "text/html",
        body: fromEngine ? body.toString().replace("<html ", "<html data-deals-saves-from-engine ") : body,
      }),
    );
  }
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
      await page.getByRole("heading", { name: "No updates yet", exact: true }).waitFor();
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

    test(`an empty Updates read says so once at ${width}px in ${theme} mode`, async (t) => {
      const { page } = await open(t, width, theme);
      await page.clock.setFixedTime(new Date("2026-07-01T12:27:00Z"));
      await page.goto(updates);
      await page.getByRole("heading", { name: "No updates yet", exact: true }).waitFor({ timeout: 2500 });
      assert.equal(await page.locator("#feedAsOf").textContent(), "As of 7:27 AM");
      assert.equal(
        await page.getByRole("heading", { level: 1, name: "Updates", exact: true }).count(),
        1,
        "no count at zero",
      );
      assert.equal(
        await page
          .getByText(/^No (notifications|recent activity)$/)
          .filter({ visible: true })
          .count(),
        0,
        "one empty line, not three",
      );
      const line = await page.locator("#feedState").evaluate((node) => getComputedStyle(node).borderTopWidth);
      assert.equal(line, "0px", "a quiet line, not a card");
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
          await page.locator(".app-layout-center").getByText("Closing anniversaries", { exact: true }).count(),
          1,
          "the title shows once",
        );
        assert.doesNotMatch((await page.locator("#main").textContent()) ?? "", /Critical dates/);
        assert.equal(
          await page
            .locator("#clientAnniversaries")
            .getByRole("link", { name: "Synthetic Closing" })
            .getAttribute("href"),
          "/deals?deal=synthetic-deal",
        );
        if (entry === "More") await capture(page, "closing-anniversaries", width, theme);
      });
    }
  }

const manyUpdates = Array.from({ length: 20 }, (_, n) => ({
  ...unread,
  source_id: `22222222-2222-4222-8222-${String(n).padStart(12, "0")}`,
  title: `${unread.title} ${n + 1}`,
}));
const manyChanges = Array.from({ length: 30 }, (_, n) => change("Joe", `moved Example Dental to phase ${n + 1}`));
const fullFeed = {
  "GET /api/engine/updates": () => ({ json: { unread_count: 20, updates: manyUpdates } }),
  "GET /api/engine/updates/changes": () => ({ json: { changes: manyChanges, next_before: null } }),
};

const screenFit = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect();
    const scrolls = (selector: string) => {
      const node = document.querySelector(selector);
      return Boolean(node && node.scrollHeight > node.clientHeight);
    };
    const rows = [...document.querySelectorAll("#feedList > .update-row")].map(
      (row) => row.getBoundingClientRect().height,
    );
    return {
      pageScrolls: scrolls("#appMainSlot") || document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      feedScrolls: scrolls("#feedList"),
      activityScrolls: scrolls("#activityList"),
      feedTop: Math.round(box("#feedList")?.top ?? 0),
      feedBottom: Math.round(box("#feedList")?.bottom ?? 0),
      besideFeed: (box("#activityList")?.left ?? 0) > (box("#feedList")?.right ?? Infinity),
      tallestRow: Math.round(Math.max(...rows)),
    };
  });

const widthOf = async (locator: Locator) => (await locator.boundingBox())?.width ?? Number.NaN;

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const)
  for (const today of ["open", "closed"])
    for (const theme of themes)
      test(`Updates fits one screen at ${width}x${height} with Today ${today} in ${theme} mode`, async (t) => {
        const { page } = await open(t, width, theme, fullFeed, true, height);
        await page.addInitScript((state) => localStorage.setItem("doctorcre:today", state), today);
        await page.goto(updatesPath);
        await page.getByRole("heading", { name: `${unread.title} 1`, exact: true }).waitFor({ timeout: 2500 });
        await page.locator("#activityList > li").first().waitFor();
        assert.equal(
          await page.getByRole("heading", { level: 1 }).textContent(),
          "Updates 20 unread",
          "the unread count sits in the title",
        );
        const fit = await screenFit(page);
        assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
        assert.equal(fit.sideways, false, "nothing scrolls sideways");
        assert.equal(fit.feedScrolls, true, "the feed scrolls inside itself");
        assert.equal(fit.activityScrolls, true, "Who did what scrolls inside itself");
        assert.equal(fit.besideFeed, true, "Who did what sits beside the feed");
        assert.ok(fit.feedTop <= 112, `the feed starts near the top, not at ${fit.feedTop}px`);
        assert.ok(fit.feedBottom <= height, "the feed ends on screen");
        assert.ok(fit.tallestRow <= 64, `a two-line row is at most 64px, not ${fit.tallestRow}px`);
        await capture(page, `updates-fit-${today === "open" ? "today" : "wide"}`, width, theme);
      });

for (const theme of themes)
  test(`Updates stacks the feed over Who did what on a phone in ${theme} mode`, async (t) => {
    const { page } = await open(t, 390, theme, fullFeed);
    await page.goto(updatesPath);
    await page.getByRole("heading", { name: `${unread.title} 1`, exact: true }).waitFor({ timeout: 2500 });
    const fit = await screenFit(page);
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.equal(fit.feedScrolls, false, "the page scrolls, not a box inside it");
    assert.equal(fit.besideFeed, false, "Who did what follows the feed");
    const act = await page.getByRole("button", { name: "Mark read" }).first().boundingBox();
    assert.ok(act && act.height >= 44, "the row's button is a full touch target");
    await capture(page, "updates-fit-phone", 390, theme);
  });

test("an update row opens on click and with the keyboard, and marks read from the row", async (t) => {
  const { page, sent } = await open(
    t,
    1280,
    "dark",
    {
      "GET /api/engine/updates": () => ({ json: { unread_count: 1, updates: [unread] } }),
      "GET /api/engine/updates/changes": () => ({ json: { changes: [change("Joe", "moved it")], next_before: null } }),
      "POST /api/engine/updates/read": () => ({
        json: { ok: true, updates: [{ id: unread.source_id, read_at: "2026-11-21T12:00:00Z" }], unread_count: 0 },
      }),
    },
    true,
    800,
  );
  await page.goto(updatesPath);
  const row = page.locator("#feedList > .update-row").first();
  const toggle = row.getByRole("button", { name: unread.title });
  await toggle.waitFor({ timeout: 2500 });
  assert.equal(await toggle.getAttribute("aria-expanded"), "false");
  await row.locator(".note-subject").click();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "a click on the row opens it");
  await toggle.press("Enter");
  assert.equal(await toggle.getAttribute("aria-expanded"), "false", "Enter closes it again");
  await toggle.press("Space");
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "Space opens it");
  const change_ = page.locator("#activityList > .update-row").first();
  await change_.getByRole("button", { name: "moved it" }).click();
  assert.equal(await change_.locator(".row-more").isVisible(), true, "Who did what rows open the same way");

  await row.getByRole("button", { name: "Mark read", exact: true }).click();
  await row.getByText("Read at 6:00 AM", { exact: true }).waitFor();
  assert.equal(await toggle.getAttribute("aria-expanded"), "true", "the row stays open after the save");
  const [save] = sent.filter(({ key }) => key === "POST /api/engine/updates/read");
  assert.deepEqual(save?.body?.update_ids, [unread.source_id]);
  assert.equal(await page.locator("#unreadLine").textContent(), "");
});

test("Who did what leads with the record and folds a run of one change; an empty feed is one line", async (t) => {
  const notes = Array.from({ length: 24 }, (_, n) => ({
    ...change("", "added a note"),
    id: `${n}`,
    job: "agent",
    record: `Clinic ${n + 1}`,
  }));
  const { page } = await open(t, 1280, "dark", {
    "GET /api/engine/updates/changes": () => ({
      json: { changes: [change("Joe", "moved the deal to LOI"), ...notes], next_before: null },
    }),
  });
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: "No notifications", exact: true }).waitFor({ timeout: 2500 });
  const rows = page.locator("#activityList > .update-row");
  assert.equal(await rows.nth(0).getByRole("heading").textContent(), "Example Dental · moved the deal to LOI");
  assert.equal(
    await rows.nth(0).getByRole("link", { name: "Example Dental" }).getAttribute("href"),
    `/deals?deal=${deal}`,
  );
  assert.equal(await rows.nth(0).locator(".note-subject").textContent(), "Joe");
  assert.equal(
    await rows.nth(0).locator(".row-meta").textContent(),
    "9:00 AM",
    "the time sits at the row's end, as in the feed",
  );
  assert.equal(await rows.count(), 2, "the 24 notes read as one row");
  assert.equal(await rows.nth(1).locator(".note-subject").textContent(), "Written by the assistant");
  await rows.nth(1).getByRole("button", { name: "24 records · added a note", exact: true }).click();
  const records = rows.nth(1).locator(".fold-list a");
  assert.equal(await records.count(), 24, "it opens to every record");
  assert.deepEqual(
    [await records.first().textContent(), await records.first().getAttribute("href")],
    ["Clinic 1", `/deals?deal=${deal}`],
  );
  await capture(page, "updates-fold", 1280, "dark");
});

test("Updates groups rows by day, marks unread with a dot and keeps row controls quiet", async (t) => {
  const at = (iso: string, n: number) => ({
    ...unread,
    source_id: `55555555-5555-4555-8555-${String(n).padStart(12, "0")}`,
    title: `Update ${n}`,
    activity_at: iso,
  });
  const days = [
    "2026-11-25T15:00:00Z",
    "2026-11-24T15:00:00Z",
    "2026-11-20T15:00:00Z",
    "2026-11-02T15:00:00Z",
    "2025-12-01T15:00:00Z",
  ];
  const updates = [...days.map(at), { ...seen, activity_at: days[4] }];
  const changes = days.map((changed_at, n) => ({ ...change("Joe", `moved the deal to phase ${n}`), changed_at }));
  const { page } = await open(
    t,
    1280,
    "light",
    {
      "GET /api/engine/updates": () => ({ json: { unread_count: 5, updates } }),
      "GET /api/engine/updates/changes": () => ({ json: { changes, next_before: null } }),
    },
    true,
    640,
  );
  await page.clock.setFixedTime(new Date("2026-11-25T18:00:00Z"));
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: "Update 0", exact: true }).waitFor({ timeout: 2500 });
  await page.locator("#activityList > .update-row").first().waitFor();
  const headings = ["Today", "Yesterday", "Friday", "Nov 2", "Dec 1, 2025"];
  assert.deepEqual(await page.locator("#feedList > .day-head").allTextContents(), headings);
  assert.deepEqual(await page.locator("#activityList > .day-head").allTextContents(), headings);

  assert.equal(
    await page.locator("#feedList").getByText("Update", { exact: true }).count(),
    0,
    "no label repeats the page's name",
  );
  assert.equal(
    await page
      .locator("#feedList .severity-chip")
      .allTextContents()
      .then((all) => all.join()),
    "Tour feedback",
  );

  const row = (title: string) =>
    page.locator("#feedList > .update-row").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
  const edge = (title: string) => row(title).evaluate((node) => getComputedStyle(node).borderLeftColor);
  const dot = (title: string) => row(title).locator(".row-meta .unread-dot");
  assert.equal(await edge("Update 0"), "rgba(0, 0, 0, 0)", "unread is not a warning edge");
  assert.notEqual(
    await dot("Update 0").evaluate((node) => getComputedStyle(node).backgroundColor),
    "rgba(0, 0, 0, 0)",
    "unread shows a dot",
  );
  assert.equal(await dot(seen.title).count(), 0, "a read row has no dot");
  assert.equal(
    await row("Update 0").locator(".row-meta").getByText("Unread", { exact: true }).count(),
    1,
    "a screen reader hears the dot as Unread",
  );
  assert.equal(await row(seen.title).getByText("Unread", { exact: true }).count(), 0);

  const clockEdges = (list: string) =>
    page
      .locator(`${list} > .update-row .row-clock`)
      .evaluateAll((clocks) => clocks.map((clock) => Math.round(clock.getBoundingClientRect().right)));
  for (const width of [1280, 390]) {
    await page.setViewportSize({ width, height: 640 });
    for (const list of ["#feedList", "#activityList"]) {
      const edges = await clockEdges(list);
      assert.ok(edges.length > 1, `${list} has rows to compare`);
      assert.equal(new Set(edges).size, 1, `at ${width} every ${list} time ends at one edge, not ${edges}`);
    }
    await capture(page, "updates-days", width, "light");
  }
  await page.setViewportSize({ width: 1280, height: 640 });

  const markRead = await row("Update 0").getByRole("button", { name: "Mark read", exact: true }).boundingBox();
  assert.ok(
    markRead && markRead.height >= 28 && markRead.height <= 32 && markRead.width <= 32,
    "Mark read is a small control",
  );
  const decoration = (locator: ReturnType<Page["locator"]>) =>
    locator.first().evaluate((node) => getComputedStyle(node).textDecorationLine);
  assert.equal(await decoration(row("Update 0").getByRole("link")), "none", "the row's link is quiet until hovered");
  assert.equal(
    await decoration(page.locator("#activityList a.row-lead")),
    "none",
    "a record name is quiet until hovered",
  );
  assert.equal(
    await page
      .locator("main")
      .getByText(/^As of /)
      .count(),
    1,
    "one As of for the page",
  );
  assert.equal(await page.getByRole("button", { name: "Refresh", exact: true }).textContent(), "↻");
});

test("Mark read by keyboard keeps focus on its row, or the next row when it leaves", async (t) => {
  const second = { ...seen, read_at: null };
  let gone = false;
  const { page } = await open(t, 1280, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 2, updates: gone ? [second] : [unread, second] } }),
    "POST /api/engine/updates/read": (request) => {
      const [id] = request.postDataJSON().update_ids;
      gone ||= id === unread.source_id;
      return id === unread.source_id
        ? { status: 404, json: { error: "not_found" } }
        : { json: { ok: true, updates: [{ id, read_at: "2026-11-21T12:00:00Z" }], unread_count: 0 } };
    },
  });
  await page.goto(updatesPath);
  const focused = () =>
    page.evaluate(
      () =>
        `${document.activeElement?.closest("[data-row]")?.getAttribute("data-row")} ${document.activeElement?.className}`,
    );
  const markRead = (id: string) =>
    page.locator(`[data-row="${id}"]`).getByRole("button", { name: "Mark read", exact: true });
  await markRead(unread.source_id).press("Enter", { timeout: 2500 });
  await page.locator(`[data-row="${unread.source_id}"]`).waitFor({ state: "detached" });
  assert.equal(await focused(), `${second.source_id} row-toggle`, "focus moves to the next row");
  await markRead(second.source_id).press("Enter");
  await page.getByText("Read at 6:00 AM", { exact: true }).waitFor();
  assert.equal(await focused(), `${second.source_id} row-toggle`, "focus stays on the same row");
});

test("an old-feed change stays open when a refresh brings a newer one", async (t) => {
  const event = (id: string, field: string) => ({
    id,
    field,
    verb: "patch-deal-field",
    actor: "joe",
    subject_type: "deal",
    subject_id: deal,
    recorded_at: `2026-11-20T1${id}:00:00Z`,
  });
  let events = [event("1", "phase")];
  const { page } = await open(t, 1280, "dark", {}, false);
  await page.route("**/pipeline/changes**", (route) => {
    const from = Number(new URL(route.request().url()).searchParams.get("cursor") ?? 0);
    return route.fulfill({ json: { events: events.slice(from), cursor: `${events.length}` } });
  });
  await page.goto(updatesPath);
  const older = page.getByRole("button", { name: "Phase", exact: true });
  await older.click({ timeout: 2500 });
  events = [...events, event("2", "note")];
  await page.getByRole("button", { name: "Refresh", exact: true }).click();
  const newer = page.getByRole("button", { name: "Note added", exact: true });
  await newer.waitFor();
  assert.deepEqual(
    [await older.getAttribute("aria-expanded"), await newer.getAttribute("aria-expanded")],
    ["true", "false"],
  );
});

test("an invalid feed reply offers Retry instead of staying in loading", async (t) => {
  const { page } = await open(t, 390, "dark", { "GET /api/engine/updates": () => ({ json: {} }) });
  await page.goto(`${server.origin}/updates?mode=live`);
  await page.getByRole("heading", { name: "Couldn't load updates", exact: true }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Retry", exact: true }).isVisible(), true);
});

const updatesPath = `${server.origin}/updates?mode=live`;
const settingsPath = `${server.origin}/settings?mode=live`;
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
  const today = page.waitForRequest("**/api/engine/home/today");
  await page.getByRole("link", { name: "Updates", exact: true }).click();
  await today;
  await page.getByRole("heading", { name: unread.title }).waitFor({ timeout: 2500 });
  assert.equal(await page.locator("#unreadLine").textContent(), "1 unread");
  assert.equal(await page.getByText(unread.why, { exact: true }).count(), 1);
  const open_ = page.getByRole("link", { name: "Open checklist item" });
  assert.equal(await open_.getAttribute("href"), unread.open_url);
  assert.equal(await page.getByRole("heading", { name: seen.title }).count(), 1);
  assert.equal(await page.getByRole("link", { name: "Review feedback" }).getAttribute("href"), seen.open_url);
  await page.getByText("No recent activity", { exact: true }).waitFor();
  assert.equal(await page.locator("#prefForm").count(), 0, "settings live on their own page");
  assert.deepEqual([...new Set(sent.map(({ key }) => key))].sort(), [
    "GET /api/engine/home/today",
    "GET /api/engine/preferences",
    "GET /api/engine/updates",
    "GET /api/engine/updates/changes",
  ]);
  assert.deepEqual(verbs, []);
  const unreadCard = page.getByRole("listitem").filter({ has: page.getByRole("heading", { name: unread.title }) });
  assert.equal(await unreadCard.getByText("9:00 AM", { exact: true }).count(), 1);
  assert.equal(await unreadCard.getByRole("button", { name: "Mark read", exact: true }).count(), 1);
  assert.equal(await page.getByText("Read at 10:00 AM", { exact: true }).count(), 1);
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
  await page.getByText("Read at 6:00 AM", { exact: true }).waitFor();
  assert.equal(await page.locator("#navUnreadBadge").getAttribute("aria-label"), "2 unread notifications");
  const [save] = sent.filter(({ key }) => key === "POST /api/engine/updates/read");
  assert.deepEqual(save?.body?.update_ids, [unread.source_id]);
  assert.match(String(save?.body?.idempotency_key), /^[0-9a-f-]{36}$/);
});

test("Mark all read reuses the key after an unanswered save", async (t) => {
  const second = { ...seen, read_at: null, unseen: true };
  const shown = [unread, second];
  const readAt = "2026-11-21T12:00:00Z";
  const updates = shown.map(({ source_id: id }) => ({ id, read_at: readAt }));
  let attempts = 0;
  const { page, sent } = await open(t, 390, "dark", {
    "GET /api/engine/updates": () => ({
      json: attempts
        ? { unread_count: 0, updates: shown.map((row) => ({ ...row, read_at: readAt })) }
        : { unread_count: 2, updates: shown },
    }),
    "POST /api/engine/updates/read": () =>
      ++attempts === 1
        ? { status: 503, json: { error: "unavailable" } }
        : { json: { ok: true, replayed: true, unread_count: 0, updates } },
  });
  await page.goto(updatesPath);
  await page.getByRole("button", { name: "Mark all read", exact: true }).click({ timeout: 2500 });
  await page.getByRole("button", { name: "Check outcome" }).click();
  await page.locator("#unreadLine:empty").waitFor({ state: "attached" });
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
  await page.getByText("Read at 7:00 AM", { exact: true }).waitFor();
  const badge = page.locator("#navUnreadBadge");
  assert.equal(await badge.getAttribute("aria-label"), null);

  await check.click();
  await page.getByText("Read at 6:00 AM", { exact: true }).waitFor();
  assert.equal(await page.getByText("Read at 7:00 AM", { exact: true }).count(), 1);
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
  await page.getByRole("heading", { name: "No updates yet", exact: true }).waitFor();
  assert.equal(await page.locator("#navUnreadBadge").getAttribute("aria-label"), null);
});

test("Settings shows the Updates unread count in the navigation", async (t) => {
  const { page } = await open(t, 1440, "dark", {
    "GET /api/engine/updates": () => ({ json: { unread_count: 1, updates: [unread] } }),
  });
  await page.goto(settingsPath);
  await page.locator("#navUnreadBadge[aria-label='1 unread notification']").waitFor({ state: "attached" });
});

test("Settings opens from the account menu and saves without showing a time zone", async (t) => {
  const { page, sent } = await open(t, 1440, "dark", preferenceStore({ ...preferences, time_zone: "America/Denver" }));
  await page.goto(updatesPath);
  await page.locator("#selfAvatar").click();
  const link = page.locator("#accountMenu").getByRole("link", { name: "Settings", exact: true });
  assert.equal(await link.getAttribute("href"), "/settings");
  await page.goto(settingsPath);
  await page.locator("#prefForm").waitFor();
  assert.equal(await page.getByLabel("Timezone").count(), 0);
  assert.equal(await page.locator("#quietStart").inputValue(), "");
  assert.equal(await page.locator("#deviceOptIn").isChecked(), false);
  assert.equal(await page.locator("#prefSummary").textContent(), "No quiet hours set · device push off");
  await page.locator("#quietStart").fill("10:00 PM");
  await page.locator("#quietEnd").fill("7:00 AM");
  await page.locator("#deviceOptIn").check();
  await saveButton(page).click();
  await page.locator("#prefMessage").getByText("Saved", { exact: true }).waitFor();
  assert.deepEqual(savedFields(sent), [
    { base_version: 0, time_zone: "America/Denver", quiet_from: "22:00", quiet_until: "07:00", push_to_device: true },
  ]);
  await page
    .locator("#prefSummary")
    .getByText("Quiet hours 10:00 PM to 7:00 AM · device push on", { exact: true })
    .waitFor();
  assert.doesNotMatch((await page.locator("main").textContent()) ?? "", /America\/Denver/);
});

for (const [width, height] of [
  [1280, 720],
  [1440, 900],
  [390, 844],
] as const)
  test(`Settings is one readable column with unset quiet hours empty at ${width}`, async (t) => {
    const { page } = await open(t, width, "dark", {}, true, height);
    await page.goto(settingsPath);
    await page.locator("#prefForm").waitFor();
    await mkdir("out/test-artifacts/settings", { recursive: true });
    await page.screenshot({ path: `out/test-artifacts/settings/settings-quiet-unset-${width}.png` });
    for (const box of [page.getByLabel("Quiet hours start"), page.getByLabel("Quiet hours end")]) {
      assert.equal(await box.inputValue(), "");
      assert.equal(await box.getAttribute("placeholder"), "Not set", "an empty box does not show a time");
      assert.ok((await widthOf(box)) <= 160, "a time box is sized for a time");
      const height = (await box.boundingBox())?.height ?? Number.NaN;
      if (width > 760) assert.equal(height, 32, "a time box is a computer-sized control");
      else assert.ok(height >= 44, "a time box keeps its touch size on a phone");
    }
    const push = page.getByRole("switch", { name: "Device push", exact: true });
    assert.equal(await push.count(), 1, "the switch is named by its label alone");
    const hint = await push.getAttribute("aria-describedby");
    assert.equal(
      await page.locator(`[id="${hint}"]`).textContent(),
      "Send a device push when something is addressed to me",
    );
    assert.equal(
      await page
        .locator(".setting-text")
        .first()
        .evaluate((el) => getComputedStyle(el).rowGap),
      "4px",
    );
    assert.equal(await page.getByRole("button", { name: "Clear quiet hours" }).isVisible(), false);
    assert.equal(
      await page
        .locator("main")
        .getByText(/^As of /)
        .count(),
      0,
    );
    const column = await widthOf(page.locator("#quietHoursBlock"));
    assert.ok(column <= 720, `the settings column is ${column}px wide`);
    assert.ok((await widthOf(saveButton(page))) < column / 2 || width < 560, "Save is a button, not a full-width bar");
    const overflow = await page.evaluate(() => ({
      x: document.documentElement.scrollWidth > innerWidth,
      y: document.documentElement.scrollHeight > innerHeight,
    }));
    assert.equal(overflow.x, false, "no sideways scroll");
    if (width > 760) assert.equal(overflow.y, false, "Settings fits one screen");
  });

test("Settings offers Clear quiet hours only once quiet hours are saved", async (t) => {
  const { page } = await open(
    t,
    1440,
    "dark",
    preferenceStore({ ...preferences, quiet_from: "22:00", quiet_until: "07:00" }),
  );
  await page.goto(settingsPath);
  const clear = page.getByRole("button", { name: "Clear quiet hours" });
  await clear.waitFor();
  assert.equal(await page.getByLabel("Quiet hours start").inputValue(), "10:00 PM");
  await clear.click();
  await page.locator("#prefSummary").getByText("No quiet hours set · device push off", { exact: true }).waitFor();
  assert.equal(await clear.isVisible(), false);
  assert.equal(await page.getByLabel("Quiet hours start").inputValue(), "");
});

test("Settings rows answer the pointer", async (t) => {
  const { page } = await open(t, 1440, "dark");
  await page.goto(settingsPath);
  await page.locator("#prefForm").waitFor();
  const row = page.locator("label.setting-row");
  const fill = () => row.evaluate((el) => getComputedStyle(el).backgroundColor);
  const rest = await fill();
  await row.hover();
  const fillIs = (same: boolean) =>
    page.waitForFunction(
      ([before, same]) => {
        const row = document.querySelector("label.setting-row");
        return !!row && (getComputedStyle(row).backgroundColor === before) === same;
      },
      [rest, same] as const,
    );
  await fillIs(false);
  await page.mouse.move(0, 0);
  await fillIs(true);
});

test("keyboard focus stays on the Settings control that saved", async (t) => {
  const { page } = await open(
    t,
    1440,
    "dark",
    preferenceStore({ ...preferences, quiet_from: "22:00", quiet_until: "07:00" }),
  );
  await page.goto(settingsPath);
  const activeId = () => page.evaluate(() => document.activeElement?.id ?? "");
  const save = saveButton(page);
  await save.focus();
  await save.press("Enter");
  await page.locator("#prefMessage").getByText("Saved", { exact: true }).waitFor();
  assert.equal(await activeId(), "prefSave", "Save keeps focus once it answers");

  const clear = page.getByRole("button", { name: "Clear quiet hours" });
  await clear.focus();
  await clear.press("Enter");
  await page.locator("#prefSummary").getByText("No quiet hours set · device push off", { exact: true }).waitFor();
  assert.equal(await clear.isVisible(), false);
  assert.equal(await activeId(), "quietStart", "focus moves to the first time box when Clear hides");
});

test("checking a settings save outcome keeps newer preferences on screen", async (t) => {
  const saved = { ...preferences, quiet_from: "22:00", quiet_until: "07:00", base_version: 5 };
  const newer = { ...preferences, quiet_from: "21:00", quiet_until: "06:00", base_version: 6 };
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
  await page.goto(settingsPath);
  const start = page.getByLabel("Quiet hours start");
  await start.fill("10:00 PM");
  await page.getByLabel("Quiet hours end").fill("7:00 AM");
  await saveButton(page).click();
  const check = page.locator("#prefForm").getByRole("button", { name: "Check outcome" });
  await check.waitFor();
  current = newer;
  await page.evaluate(() => dispatchEvent(new Event("online")));
  const summary = page.locator("#prefSummary");
  await summary.getByText(/9:00 PM to 6:00 AM/).waitFor();

  await check.press("Enter");
  await saveButton(page).waitFor();
  assert.equal(await start.inputValue(), "9:00 PM");
  assert.match((await summary.textContent()) ?? "", /9:00 PM to 6:00 AM/);
});

test("notification settings explain an unpaired quiet hour", async (t) => {
  const { page, sent } = await open(t, 390, "dark");
  await page.goto(settingsPath);
  await page.locator("#prefForm").waitFor();
  await page.locator("#quietStart").fill("10:00 PM");
  await saveButton(page).click();
  await page
    .locator("#prefMessage")
    .getByText(/start and an end that differ/)
    .waitFor();
  assert.equal(savedFields(sent).length, 0);
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
  await page.goto(settingsPath);
  await page.locator("#prefForm").waitFor();
  await page.locator("#deviceOptIn").check();
  await saveButton(page).click();
  await page
    .locator("#prefMessage")
    .getByText(/^Preferences changed elsewhere\. Your changes were not saved\./)
    .waitFor();
  await page.locator("#prefSummary").getByText("No quiet hours set · device push on").waitFor();
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
  await page.getByRole("heading", { name: "Example Dental · moved the deal to LOI" }).waitFor();
  assert.equal(await page.locator("#activityList").getByText("Alex Example", { exact: true }).count(), 1);
  assert.equal(
    await page.locator("#activityList").getByRole("link", { name: "Example Dental" }).getAttribute("href"),
    `/deals?deal=${deal}`,
  );
  await page.getByRole("button", { name: "Show more" }).click();
  await page.getByRole("heading", { name: "Example Dental · added a note" }).waitFor();
  assert.equal(await page.getByRole("heading", { name: "Example Dental · moved the deal to LOI" }).count(), 1);
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
  await page.getByRole("heading", { name: "Example Dental · opened the deal" }).waitFor();
  assert.equal(await page.getByRole("button", { name: "Show more" }).isVisible(), false);
  assert.deepEqual(
    sent.filter(({ key }) => key.endsWith("/changes")).map(({ search }) => search),
    ["", `?before=${encodeURIComponent(before)}`, ""],
  );
});

test("switch off keeps the old feed, settings and activity reads", async (t) => {
  const { page, sent, verbs } = await open(t, 390, "dark", {}, false);
  await page.goto(updatesPath);
  await page.getByRole("heading", { name: "No updates yet", exact: true }).waitFor();
  await page.goto(settingsPath);
  await page.locator("#prefSummary").getByText("No quiet hours set · device push off", { exact: true }).waitFor();
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
  await page.goto(settingsPath);
  const draft = page.getByLabel("Quiet hours start");
  await draft.fill("10:00 PM");
  await page.getByLabel("Quiet hours end").fill("7:00 AM");
  await saveButton(page).click();
  const panel = page.getByRole("region", { name: "Notifications" });
  await panel.locator('#prefState[data-state="unavailable"]').waitFor();
  assert.equal(await draft.isVisible(), true, "the unsaved quiet hours remain visible");
  assert.equal(await draft.inputValue(), "10:00 PM");
  const notice = panel
    .getByRole("status")
    .filter({ hasText: /^Preferences changed elsewhere\. Your changes were not saved\./ });
  await notice.waitFor();

  available = true;
  await panel.getByRole("button", { name: "Retry", exact: true }).click();
  await panel.locator("#prefSummary").getByText("No quiet hours set · device push off", { exact: true }).waitFor();
  assert.equal(await draft.inputValue(), "10:00 PM");
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
  await rows.getByText("Example Dental · added a note").waitFor();
  refreshed = true;
  await page.clock.fastForward(60_000);
  await rows.getByText("Example Dental · signed the lease").waitFor({ timeout: 5_000 });
  const expected = [
    "Example Dental · signed the lease",
    "Example Dental · sent the draft",
    "Example Dental · opened the deal",
    "Example Dental · added a note",
  ];
  assert.deepEqual(await rows.allTextContents(), expected);
  await more.click();
  await rows.getByText("Example Dental · added the lead").waitFor();
  assert.deepEqual(await rows.allTextContents(), [...expected, "Example Dental · added the lead"]);
  assert.equal(await more.isVisible(), false);
});
