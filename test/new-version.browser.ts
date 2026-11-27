import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";

const server = await (await createQaServer()).start();
const browser = await chromium.launch();
test.after(async () => {
  await browser.close();
  await server.close();
});

type Release = { version: string | null };

async function open(t: TestContext, release: Release): Promise<Page> {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
  t.after(() => page.close());
  await page.addInitScript(() =>
    localStorage.setItem(
      "doctorcre.visual-preferences",
      JSON.stringify({ walkthroughSeen: { joe: true, dell: true } }),
    ),
  );
  await page.route("https://fonts.googleapis.com/**", (route) => route.fulfill({ contentType: "text/css", body: "" }));
  await page.route(`${server.origin}/**`, async (route) => {
    const response = await route.fetch();
    const headers = response.headers();
    if (release.version) headers["server-timing"] = `version;desc="${release.version}"`;
    await route.fulfill({ response, headers });
  });
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "new-version", viewer: "joe", reset: true },
  });
  await page.goto(`${server.origin}/deals`);
  await page.locator("#appTopbar").waitFor();
  return page;
}

let probes = 0;
// Resolves after the notice's own observer has seen this response: observers run in the order they were made.
const respond = (page: Page, release: Release, version: string | null) => {
  release.version = version;
  return page.evaluate(async (path) => {
    const seen = new Promise<void>((resolve) =>
      new PerformanceObserver((list, observer) => {
        if (!list.getEntries().some((entry) => entry.name.endsWith(path))) return;
        observer.disconnect();
        resolve();
      }).observe({ type: "resource" }),
    );
    await fetch(path);
    await seen;
  }, `/js/routes.js?probe=${++probes}`);
};

const notice = (page: Page) => page.getByRole("status").filter({ hasText: "A new version is ready" });

test("a response from a newer version shows one quiet line that reloads and stays closed for that version", async (t) => {
  const release: Release = { version: "release-one" };
  const page = await open(t, release);
  await respond(page, release, "release-one");
  await respond(page, release, null);
  assert.equal(await notice(page).count(), 0, "same or no version shows nothing");

  await respond(page, release, "release-two");
  assert.equal(await notice(page).textContent(), "A new version is ready · Reload×");
  const line = await notice(page).boundingBox();
  const main = await page.locator("#appMainSlot").boundingBox();
  assert.ok(line && main && line.y + line.height <= main.y, "the line sits above the page content, not over it");

  await page.getByRole("button", { name: "Close new version notice" }).click();
  await respond(page, release, "release-two");
  assert.equal(await notice(page).isVisible(), false, "closed stays closed for that version");

  await respond(page, release, "release-three");
  assert.equal(await notice(page).isVisible(), true, "a later version shows the line again");
  await Promise.all([page.waitForEvent("load"), notice(page).getByRole("button", { name: "Reload" }).click()]);
  assert.equal(
    await page.evaluate(
      () =>
        performance.getEntriesByType("navigation").find((entry) => entry instanceof PerformanceNavigationTiming)?.type,
    ),
    "reload",
  );
  await page.locator("#appTopbar").waitFor();
  await respond(page, release, "release-three");
  assert.equal(await notice(page).count(), 0, "the reloaded tab is current");
});

test("a page loaded without a version never shows the line", async (t) => {
  const release: Release = { version: null };
  const page = await open(t, release);
  await respond(page, release, "release-two");
  assert.equal(await notice(page).count(), 0);
});
