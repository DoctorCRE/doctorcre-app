import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const shots = process.env.CLIENT_PORTAL_SHOTS ?? "out/test-artifacts/deal-client-portal";
await mkdir(shots, { recursive: true });
const dealId = "00000000-0000-4000-8000-00000000d170";
const share = "https://share.example.test";
const site = `${share}/example-cedar`;
const grant = `${share}/example-cedar/?grant=00000000-0000-4000-8000-00000000d171`;
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };

type PortalOptions = { width?: number; height?: number; theme?: "dark" | "light"; url?: string | null };

async function openPortal(
  t: TestContext,
  { width = 1440, height = 772, theme = "dark", url = site }: PortalOptions = {},
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { CARR: { fetch: async () => Response.json(session) }, ENGINE_ROUTING: { get: async () => "on" } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
  await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
  await context.grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.origin });
  await context.route(`${share}/**`, (route) =>
    route.fulfill({ contentType: "text/html", body: "<title>Example client site</title>" }),
  );
  const page = await context.newPage();
  await page.clock.setFixedTime(new Date("2026-11-25T17:00:00Z"));
  const grants: string[] = [];
  const deal = {
    id: dealId,
    deal_id: dealId,
    name: "Example Cedar Dental Relocation",
    client_name: "Example Cedar Dental",
    client_id: "00000000-0000-4000-8000-00000000c170",
    phase: "site_selection",
    owner: "joe",
    seen: 4,
    kind: "lease",
    reason: "relocation",
    market: "Example City",
    client_portal_url: url,
    next_deal_saves: true,
    next_actions: [],
    critical_dates: [],
    vendors: [],
    email_follow_ups: [],
    correspondence: [],
    documents: [],
  };
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    CLIENT_WEBSITE_ORIGIN: share,
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        if (request.method === "POST" && path === `/api/engine/deals/${dealId}/client-website/open`) {
          grants.push(path);
          return Response.json({ url: grant });
        }
        if (path === `/api/engine/deals/${dealId}`) return Response.json(deal);
        if (path === `/api/engine/deals/${dealId}/tours`) return Response.json({ tours: [], past_tours: [] });
        if (path === "/api/engine/deals")
          return Response.json({ schema_version: "local-deals-board.v2", actor: "joe", deals: [deal] });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
  await page.route(/\/(mcp|api\/engine\/.*)$/, async (route) => {
    const request = route.request();
    const body = request.postData();
    const reply = await worker.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(body === null ? {} : { body }),
      }),
      env,
    );
    await route.fulfill({
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: Buffer.from(await reply.arrayBuffer()),
    });
  });
  await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
  await page.getByRole("tab", { name: "Client portal" }).click();
  await page.waitForLoadState("networkidle");
  return { page, grants };
}

test("the client portal tab opens the client's site unlocked and copies the client's link", async (t) => {
  const { page, grants } = await openPortal(t);
  const portal = page.getByRole("region", { name: "Website for Example Cedar Dental" });
  await portal.waitFor();
  const preview = portal.getByRole("button", { name: /share\.example\.test\/example-cedar/ });
  assert.ok(((await preview.boundingBox())?.height ?? 0) >= 200, "the preview link is large");

  const copy = portal.getByRole("button", { name: "Copy client link" });
  const openAsClient = portal.getByRole("button", { name: /^Open as client/ });
  const before = await openAsClient.boundingBox();
  await copy.click();
  await assert.doesNotReject(portal.getByRole("button", { name: "Copied" }).waitFor());
  assert.deepEqual(await openAsClient.boundingBox(), before, "Copied leaves Open as client in place");
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), site, "the copied link is the client's own");
  await portal.getByRole("button", { name: "Copy client link" }).waitFor({ timeout: 4000 });

  for (const control of [openAsClient, preview]) {
    const [tab] = await Promise.all([page.context().waitForEvent("page"), control.click()]);
    await tab.waitForURL(grant);
    await tab.close();
  }
  assert.equal(grants.length, 2, "each open asks the engine for its own one-use grant");
  assert.equal(await portal.locator("iframe").count(), 0, "the share site refuses framing, so nothing frames it");
});

test("a deal with no client website says so in one line", async (t) => {
  const { page } = await openPortal(t, { url: null });
  const panel = page.getByRole("tabpanel", { name: "Client portal" });
  assert.equal((await panel.textContent())?.trim(), "No client website yet.");
});

for (const [width, height] of [
  [1440, 772],
  [1280, 640],
  [500, 900],
] as const) {
  for (const theme of ["dark", "light"] as const) {
    test(`the client portal tab fits at ${width} in the ${theme} theme`, async (t) => {
      const { page } = await openPortal(t, { width, height, theme });
      const portal = page.getByRole("region", { name: "Website for Example Cedar Dental" });
      await portal.waitFor();
      for (const name of ["Copy client link", "Open as client", "share.example.test/example-cedar"]) {
        const bounds = await portal.getByRole("button", { name }).boundingBox();
        assert.ok(bounds && bounds.x >= 0 && bounds.x + bounds.width <= width, `${name} fits the width`);
        assert.ok(bounds.y + bounds.height <= height, `${name} is on the first screen`);
      }
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
      const preview = await portal.locator(".deal-client-portal-preview").boundingBox();
      assert.ok(preview && preview.height >= Math.min(height / 2, 360) - 1, "the preview link is large at every width");
      await page.screenshot({ path: `${shots}/dh-C6-site-${width}-${theme}.png` });
      if (width === 1440) {
        const empty = await openPortal(t, { width, height, theme, url: null });
        await empty.page.screenshot({ path: `${shots}/dh-C6-none-${width}-${theme}.png` });
      }
    });
  }
}
