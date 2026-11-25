import { expect, type Page, test } from "@playwright/test";
import worker from "../../src/worker.js";
import { ownedServer } from "../../test/fixture-probe.ts";

const empty = { state: "empty", items: [] };
const account = { account_client_id: "demo-account", account_name: "Demo National Practice", account_owner: "dell" };
let server: Awaited<ReturnType<typeof ownedServer>>;
test.beforeAll(async () => {
  server = await ownedServer();
});
test.afterAll(async () => {
  await server?.stop();
});

async function mockReads(page: Page, { engine = true, savesFromEngine = false, overnight = false } = {}) {
  const requests = { engine, feed: 0, forwarded: 0, confirms: 0, saves: 0, title: "Demo Practice Deal" };
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "staging",
    ENGINE_ROUTING: { get: async (key: string) => (key === "deals-from-engine" && requests.engine ? "on" : "off") },
    CARR: {
      fetch: async (request: Request) => {
        requests.forwarded++;
        const cursor = new URL(request.url).searchParams.get("cursor");
        const events =
          overnight && cursor && cursor !== "synthetic"
            ? [
                {
                  id: "demo-event",
                  subject_type: "deal",
                  subject_id: "d14",
                  field: "next_step",
                  verb: "set-next-step",
                  actor: "dell",
                  new_value: "Review the demo layout",
                  recorded_at: "2026-11-20T14:00:00Z",
                },
              ]
            : [];
        return Response.json({ events, cursor: "synthetic" }, { status: requests.engine ? 503 : 200 });
      },
    },
  };
  await page.route("**/*", async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== server.url) return route.abort();
    if (url.pathname === "/pipeline/changes") {
      requests.feed++;
      const response = await worker.fetch(new Request(url), env);
      return route.fulfill({ status: response.status, body: await response.text() });
    }
    if (["/auth/session", "/api/system-work/session"].includes(url.pathname)) {
      return route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } });
    }
    if (url.pathname === "/mcp") {
      const {
        id,
        params: { name },
      } = route.request().postDataJSON();
      const deal = { id: "d14", name: requests.title, phase: "legal", owner: "joe", version: 1 };
      let result = {};
      if (name === "deal-room-board") {
        result = {
          actor: "joe",
          board_from_engine: requests.engine,
          next_deal_saves: savesFromEngine,
          deals: [deal],
          accounts: [account],
        };
      } else if (name === "get-deal-room") {
        result = { ...deal, deal_id: deal.id };
      } else if (name === "add-deal-note") {
        requests.saves++;
        requests.title = "Demo Practice After Save";
        result = { ok: true, note_id: "saved-demo-note" };
      } else if (name === "capture-queue") {
        requests.confirms++;
        result = { candidates: [{ id: "demo-confirm", kind: "new_deal", payload: { name: "Demo Capture" } }] };
      } else if (name === "morning-brief") {
        result = {
          sponsor: "joe",
          sections: { today: empty, deals: { state: "ready", items: [deal] }, loops: empty, calendar: empty },
        };
      }
      return route.fulfill({
        json: { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result) }] } },
      });
    }
    if ((requests.engine || savesFromEngine) && route.request().resourceType() === "document") {
      const response = await route.fetch();
      const reads = requests.engine ? " data-deals-from-engine" : "";
      const saves = savesFromEngine ? " data-deals-saves-from-engine" : "";
      const body = (await response.text()).replace("<html", `<html${reads}${saves}`);
      return route.fulfill({ response, body });
    }
    return route.continue();
  });
  return requests;
}

const local = "/deals?mode=live";
const national = "/deals?mode=live&view=national";
const dealName = (page: Page) => page.locator('.kanban-card[data-id="d14"] .card-open');
const updated = /^Updated \d{1,2}:\d{2} [AP]M$/i;
test.use({ locale: "en-US", timezoneId: "America/Chicago" });

test("an old Client view link keeps Overview selected when the deal read fails", async ({ page }) => {
  await mockReads(page, { engine: false });
  const detailRequested = Promise.withResolvers<void>();
  const releaseDetail = Promise.withResolvers<void>();
  await page.route("**/mcp", async (route) => {
    if (route.request().postDataJSON().params.name !== "get-deal-room") return route.fallback();
    detailRequested.resolve();
    await releaseDetail.promise;
    return route.fulfill({ status: 503 });
  });
  await page.goto(`${server.url}${local}&deal=d14&tab=client-view`);
  await detailRequested.promise;
  const room = page.getByRole("main", { name: "Deal Workspace" });
  const overview = room.getByRole("tab", { name: "Overview", selected: true });
  try {
    await expect.soft(overview).toBeVisible({ timeout: 1000 });
    await expect.soft(room.getByRole("tab", { name: "Client view" })).toHaveCount(0, { timeout: 1000 });
  } finally {
    releaseDetail.resolve();
  }
  await expect(room.getByRole("status")).toHaveText("Updates temporarily unavailable");
  await expect(overview).toBeVisible();
});

for (const path of [local, national, "/search?mode=live", "/notifications?mode=live"]) {
  test(`switch on skips the legacy feed at ${path}`, async ({ page }) => {
    const requests = await mockReads(page);
    await page.goto(server.url + path);
    await expect(page.locator("#appSyncTime")).toHaveText(updated);
    expect(requests.feed).toBe(0);
    await expect(page.locator("#receiptsOpen, #receiptsJump")).toBeHidden();
  });
}

for (const [name, path] of [
  ["Local Deals", local],
  ["National Accounts", national],
] as const) {
  test(`${name} hides its moves slot outside the pulse wrapper when Deals switches are on`, async ({ page }) => {
    await mockReads(page, { savesFromEngine: true });
    await page.goto(server.url + path);
    await expect(page.locator("#appSyncTime")).toHaveText(updated);
    const moves = page.locator('[data-layout-slot="moves"]');
    await moves.evaluate((slot) => {
      slot.removeAttribute("hidden");
      document.body.append(slot);
    });
    await expect(moves).toHaveCSS("display", "none");
  });
}

test("Notifications hides Who did what once old activity is retired", async ({ page }) => {
  await mockReads(page);
  await page.goto(server.url + "/notifications?mode=live");
  await expect(page.locator("#feedState")).toHaveAttribute("data-state", /^(?!loading$)/);
  await expect(page.getByRole("heading", { name: "Who did what" })).toBeHidden();
});

test("Updates reads Who did what from the engine when Deals saves switch on by themselves", async ({ page }) => {
  await mockReads(page, { engine: false, savesFromEngine: true });
  let reads = 0;
  await page.route("**/api/engine/updates/changes", (route) => {
    reads++;
    return route.fulfill({ json: { changes: [], next_before: null } });
  });
  await page.goto(server.url + "/updates?mode=live");
  await expect(page.getByText("No recent activity", { exact: true })).toBeVisible();
  expect(reads).toBeGreaterThan(0);
});

test("an open Notifications tab stops reaching CARR after the switch flips", async ({ page }) => {
  const requests = await mockReads(page, { engine: false });
  await page.goto(server.url + "/notifications?mode=live");
  await expect(page.getByText("No recent activity", { exact: true })).toBeVisible();
  await expect(page.locator("#activityAsOf")).toHaveText(/^As of /);
  await expect(page.locator("#appSyncTime")).toHaveText(updated);
  requests.engine = true;
  const forwarded = requests.forwarded;
  const feed = requests.feed;
  await page.locator("#retryRead").click();
  await expect(page.getByRole("heading", { name: "Who did what" })).toBeHidden();
  expect(requests.feed).toBeGreaterThan(feed);
  expect(requests.forwarded).toBe(forwarded);
  const afterRetirement = requests.feed;
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/mcp" &&
      response.request().postDataJSON()?.params?.name === "notification-feed",
  );
  await page.locator("#retryRead").click();
  await refreshed;
  expect(requests.feed).toBe(afterRetirement);
});

test("National Accounts loads pending captures even with the legacy feed down", async ({ page }) => {
  const requests = await mockReads(page);
  await page.goto(server.url + national);
  await expect(page.locator("#confirmDock")).toContainText("Demo Capture");
  expect(requests.confirms).toBeGreaterThan(0);
});

for (const width of [1440, 390]) {
  test(`Deals shows the last update inline at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 900 });
    await mockReads(page);
    for (const [path, footer] of [
      [local, "#boardAsOf"],
      [national, "#syncStatus"],
    ] as const) {
      await page.goto(server.url + path);
      const stamp = page.locator(`:is(#appTopbar, #appMainSlot, #appToolsSlot) ${footer}`);
      await expect(stamp).toBeVisible();
      await expect(stamp).toHaveText(updated);
      if (process.env.DEALS_REFRESH_SCREENSHOTS) {
        await page.screenshot({ path: testInfo.outputPath(`${footer.slice(1)}-${width}.png`) });
      }
    }
  });
}

for (const trigger of ["focus", "visibility", "interval", "save"]) {
  test(`Local Deals refreshes the board on ${trigger}`, async ({ page }) => {
    const requests = await mockReads(page);
    await page.clock.install({ time: new Date("2026-11-20T16:00:00Z") });
    await page.goto(server.url + local);
    await expect(dealName(page)).toHaveText(requests.title);
    if (trigger === "save") {
      await dealName(page).click();
      await page.getByLabel("Update", { exact: true }).fill("A synthetic update");
      await page.getByRole("button", { name: "Add update", exact: true }).click();
      await expect(page.locator("#detailUpdateStatus")).toHaveText("Update added");
      expect(requests.saves).toBe(1);
      await page.getByRole("button", { name: "Back to deals", exact: true }).click();
      await expect(dealName(page)).toHaveText("Demo Practice After Save");
      return;
    }
    requests.title = "Demo Practice Refreshed";
    if (trigger === "focus") await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    if (trigger === "visibility")
      await page.evaluate(() => {
        Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
        document.dispatchEvent(new Event("visibilitychange"));
        Reflect.deleteProperty(document, "visibilityState");
        document.dispatchEvent(new Event("visibilitychange"));
      });
    if (trigger === "interval") await page.clock.fastForward(60_000);
    await expect(dealName(page)).toHaveText(requests.title);
  });
}

test("switch off keeps the legacy feed and its capture queue", async ({ page }) => {
  const requests = await mockReads(page, { engine: false });
  await page.goto(server.url + national);
  await expect(page.locator("#syncStatus")).toHaveText(/^Updated /);
  await expect(page.locator("#confirmDock")).toContainText("Demo Capture");
  expect(requests.feed).toBeGreaterThan(0);
});
