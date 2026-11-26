import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const happenedAt = "2026-11-02T16:15:00.000Z";
const dateLabel = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  dateStyle: "medium",
  timeStyle: "short",
}).format(new Date(happenedAt));
const callId = "00000000-0000-4000-8000-000000000002";
const actionId = "00000000-0000-4000-8000-000000000001";
const title = "Call the sample practice back";
const empty = { count: 0, items: [] };
const reminder = {
  item_id: `capture_post_call_action:${actionId}`,
  card_id: `capture_post_call_action:${actionId}`,
  source_type: "capture_post_call_action",
  source_id: actionId,
  source_version: "1",
  base_version: "1:0:inbox",
  source_state: "needs_attention",
  title,
  activity_at: happenedAt,
  completed_at: null,
  due_on: null,
  hold_until: null,
  snoozed_until: null,
  disposition: "inbox",
  section: "inbox",
  unseen: false,
  context_label: "Example Dental",
  open_url: `/calls?session=${callId}`,
  deal_id: null,
  kind_label: "Call follow-up",
  action_id: actionId,
  action_version: 1,
  merged_source_ids: [actionId],
  waiting_version: 0,
  waiting_on: null,
  source_activity: { kind: "call", id: callId, happened_at: happenedAt },
  undo_completion: false,
  returns_at: null,
  waiting_reason: null,
  days_late: null,
  late_label: null,
};
const dashboard = {
  ok: true,
  schema_version: "home-inbox.v6",
  home_mark_drop: true,
  home_proposal_drop: true,
  reminders: { count: 1, items: [reminder] },
  inbox: empty,
  waiting: empty,
};

test("an opened call reminder keeps Call summary and the call date from running together", {
  timeout: 180_000,
}, async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 }, timezoneId: "America/Chicago" });
  await page.addInitScript(() =>
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ walkthroughSeen: { joe: true } })),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.route(
    (url) => url.pathname === "/" && url.searchParams.get("mode") === "live",
    async (route) => {
      const response = await route.fetch();
      const body = (await response.text()).replace("<html ", "<html data-home-today-from-engine ");
      await route.fulfill({ response, body });
    },
  );
  await page.route("**/api/engine/home/inbox?view=dashboard&contract=home-inbox.v6", (route) =>
    route.fulfill({ json: dashboard }),
  );
  await page.route("**/api/engine/home/today", (route) =>
    route.fulfill({
      json: {
        ok: true,
        schema_version: "home-today.v1",
        today: "2026-11-03",
        viewer: "joe",
        meetings: { state: "empty", items: [] },
        reminders: { state: "empty", late: [], upcoming: [] },
      },
    }),
  );
  await page.goto(`${server.origin}/?mode=live`);
  await page.getByRole("link", { name: title, exact: true }).click();
  const pane = page.getByRole("region", { name: `Details for ${title}`, exact: true });
  await pane.waitFor();
  const link = pane.getByRole("link", { name: "Call summary", exact: true });
  const date = pane.locator("time");
  assert.equal(await link.getAttribute("href"), `/calls?session=${callId}`);
  assert.equal(await date.textContent(), dateLabel);
  const linkBox = (await link.boundingBox()) ?? assert.fail("Call summary is not drawn");
  const dateBox = (await date.boundingBox()) ?? assert.fail("the call date is not drawn");
  const ownLine = dateBox.y >= linkBox.y + linkBox.height - 1;
  const visibleGap = dateBox.x >= linkBox.x + linkBox.width + 4;
  assert.ok(ownLine || visibleGap, "Call summary and the date must not run together");
});
