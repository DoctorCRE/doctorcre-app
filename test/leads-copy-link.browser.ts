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

test("Copy link writes the lead URL and shows Link copied", async (t) => {
  const { page, dialog, url } = await openLeadDrawer(t);
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  await dialog.getByRole("status").filter({ hasText: "Link copied" }).waitFor();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), url);
});

test("a refused clipboard shows the fallback inside the open dialog until it closes", async (t) => {
  const { page, dialog } = await openLeadDrawer(t);
  await page.evaluate(() => {
    navigator.clipboard.writeText = () => Promise.reject(new DOMException("blocked", "NotAllowedError"));
  });
  await dialog.getByRole("button", { name: "Copy link", exact: true }).click();
  const status = dialog.locator("#copyLeadStatus");
  await status.waitFor({ state: "visible" });
  assert.equal(await status.textContent(), fallback);
  await dialog.locator("#closeDetail").click();
  await status.waitFor({ state: "hidden" });
});

for (const width of [390, 1440]) {
  test(`Copy link sits beside the close button at ${width}px, even for a long name`, async (t) => {
    const { page, dialog } = await openLeadDrawer(t);
    await page.setViewportSize({ width, height: 900 });
    await dialog.locator("#detailTitle").evaluate((node) => {
      node.textContent = "Dr. Alexandria Montgomery-Featherstonehaugh of the Very Long Named Dental Group";
    });
    const box = async (selector: string) => {
      const found = await dialog.locator(selector).boundingBox();
      assert.ok(found, `${selector} is visible`);
      return found;
    };
    const link = await box("#copyLeadLink");
    const close = await box("#closeDetail");
    const title = await box("#detailTitle");
    assert.ok(link.x + link.width <= close.x + 1, "Copy link ends before the close button");
    assert.ok(close.x - (link.x + link.width) < 24, "no large gap between Copy link and close");
    assert.ok(title.x + title.width <= link.x + 1, "the title stays left of Copy link");
    const fits = await dialog.locator("#copyLeadLink").evaluate((node) => node.scrollWidth <= node.clientWidth);
    assert.equal(fits, true, "label fits its border");
    const fontSize = (selector: string) => dialog.locator(selector).evaluate((node) => getComputedStyle(node).fontSize);
    const sizes = [await fontSize("#copyLeadLink"), await fontSize("#closeDetail")];
    assert.notEqual(sizes[0], sizes[1]);
  });
}
