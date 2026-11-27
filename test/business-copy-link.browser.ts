import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const recordId = "00000000-0000-4000-8000-000000000001";
const fallback = "Could not copy link. Copy the address from your browser.";

/** Opens a made-up client or vendor drawer on a desktop viewport, with clipboard access. */
async function openDrawer(t: TestContext, dataset: "clients" | "vendors") {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 }, reducedMotion: "reduce" });
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

test("Copy link writes the client record URL and shows Copied", async (t) => {
  const { page, panel, url } = await openDrawer(t, "clients");
  const copy = panel.getByRole("button", { name: "Copy link", exact: true });
  await copy.click();
  await panel.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
});

test("a refused clipboard keeps Copy link and tells #noticeRegion", async (t) => {
  const { page, panel } = await openDrawer(t, "vendors");
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await panel.getByRole("button", { name: "Copy link", exact: true }).click();
  await page.locator("#noticeRegion").getByText(fallback, { exact: true }).waitFor();
  assert.equal(await panel.getByRole("button", { name: "Copied", exact: true }).count(), 0);
  assert.equal(await panel.getByRole("button", { name: "Copy link", exact: true }).count(), 1);
});
