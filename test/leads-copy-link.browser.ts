import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";
import { id } from "./leads-workspace-fixture.mjs";

const leadId = id(1);
const fallback = "Could not copy link. Copy the address from your browser.";

/** Opens a made-up lead drawer on /leads, with clipboard access. */
async function openLeadDrawer(t: TestContext) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
    reducedMotion: "reduce",
  });
  await page.context().grantPermissions(["clipboard-read", "clipboard-write"], { origin: "http://localhost" });
  await routeLeads(page);
  const url = `http://localhost/leads?lead=${encodeURIComponent(leadId)}`;
  await page.goto(url);
  const dialog = page.locator("#leadDetail");
  await dialog.getByRole("heading", { name: "Dr. Example 1" }).waitFor();
  assert.equal(await dialog.evaluate((node: HTMLDialogElement) => node.open), true);
  return { page, dialog, url };
}

test("Copy link writes the lead URL and says Copied", async (t) => {
  const { page, dialog, url } = await openLeadDrawer(t);
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await dialog.getByRole("button", { name: "Copied", exact: true }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
});

test("a refused clipboard reports the fallback in #moveAnnouncement", async (t) => {
  const { page, dialog } = await openLeadDrawer(t);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await page.waitForFunction((text) => document.querySelector("#moveAnnouncement")?.textContent === text, fallback);
  assert.equal(await dialog.getByRole("button", { name: "Copy link", exact: true }).textContent(), "Copy link");
});
