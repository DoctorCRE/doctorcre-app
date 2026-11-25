import assert from "node:assert/strict";
import test from "node:test";
import type { Page } from "@playwright/test";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

async function openHome(t: test.TestContext, prepare: (page: Page) => Promise<unknown> = async () => {}) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const server = await ownedFixtureServer();
  t.after(() => server.close());
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const responses = new Map<string, Promise<string>>();
  page.on("response", (response) => {
    responses.set(
      new URL(response.url()).pathname,
      response.text().catch(() => ""),
    );
  });
  await prepare(page);
  await page.goto(server.origin);
  return { page, responses };
}

// On a phone every byte before the inbox paints delays it, so Home leaves out code its first screen never shows.
test("Home's first screen downloads no Today panel, deal item or lease watch code", async (t) => {
  const { page, responses } = await openHome(t);
  await page.locator("#homeRoot[data-home-ready] [data-inbox-row]").first().waitFor();
  await page.waitForLoadState("networkidle");
  for (const path of ["/js/deal-review-model.js", "/js/calendar-model.js", "/css/deal-items.css"])
    assert.equal(responses.has(path), false, path);
  const bodies = await Promise.all(responses.values());
  assert.equal(
    bodies.some((body) => body.includes("Confirmed watch policy")),
    false,
  );
});

test("Home loads call mode once its inbox is ready", async (t) => {
  const { page, responses } = await openHome(t, (page) =>
    page.route("**/js/ui-inbox.generated.js", (route) => route.abort()),
  );
  await page.locator("#appLayout").waitFor({ state: "attached" });
  await page.waitForLoadState("networkidle");
  assert.equal(responses.has("/js/global-call-mode.js"), false);
  const callMode = page.waitForResponse("**/js/global-call-mode.js");
  await page.locator("#homeRoot").evaluate((home) => home.dispatchEvent(new Event("doctorcre:home-ready")));
  await callMode;
});
