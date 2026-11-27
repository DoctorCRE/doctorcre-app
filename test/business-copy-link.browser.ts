import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Locator } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const recordId = "00000000-0000-4000-8000-000000000001";
const fallback = "Could not copy link. Copy the address from your browser.";

/** Opens a made-up client or vendor drawer on a desktop viewport, with clipboard access. */
async function openDrawer(t: TestContext, dataset: "clients" | "vendors", width = 1280) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: width === 1280 ? 800 : 844 },
    reducedMotion: "reduce",
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: server.url });
  await page.route("**/api/v1/business/**", (route) =>
    route.fulfill({ json: directoryFixture(route.request().url()) }),
  );
  await page.route("**/auth/session", (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
  );
  await page.goto(`${server.url}/${dataset}?record=${recordId}`);
  const panel = page.locator("#recordPanel");
  await panel.getByRole("heading", { name: dataset === "clients" ? "Demo Practice 01" : "Demo Partner 01" }).waitFor();
  return { page, panel, url: `${server.url}/${dataset}?record=${encodeURIComponent(recordId)}` };
}

/** Copy link sits in the actions menu on a phone, so the menu is opened first. */
async function pressCopyLink(panel: Locator) {
  const more = panel.getByRole("button", { name: "Record actions" });
  if (await more.isVisible()) await more.click();
  await panel.getByRole("button", { name: "Copy link", exact: true }).click();
}

test("Copy link writes the client record URL and says Link copied", async (t) => {
  const { page, panel, url } = await openDrawer(t, "clients");
  await pressCopyLink(panel);
  await panel.getByRole("status").getByText("Link copied", { exact: true }).waitFor({ state: "visible" });
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
});

test("on a phone the partner sees Link copied after the menu closes", async (t) => {
  const { panel } = await openDrawer(t, "vendors", 390);
  await pressCopyLink(panel);
  const status = panel.getByRole("status").getByText("Link copied", { exact: true });
  await status.waitFor({ state: "visible" });
  assert.equal(await panel.getByRole("button", { name: "Copy link", exact: true }).isVisible(), false);
  const box = await status.boundingBox();
  assert.ok(box && box.y >= 0 && box.y + box.height <= 844);
});

test("a refused clipboard says so inside the open drawer", async (t) => {
  const { page, panel } = await openDrawer(t, "vendors");
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await pressCopyLink(panel);
  await panel.getByRole("status").getByText(fallback, { exact: true }).waitFor({ state: "visible" });
  assert.equal(await panel.getByText("Link copied").count(), 0);
});
