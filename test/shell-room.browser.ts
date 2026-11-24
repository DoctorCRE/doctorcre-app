import assert from "node:assert/strict";
import test from "node:test";
import { createQaServer } from "../scripts/qa-fixture-server.mjs";
import { chromium } from "./browser-harness.mjs";

const pages = ["/", "/deals", "/leads", "/vendors", "/clients", "/calendar", "/relationships", "/invoices"];

test("The shell gives every desktop page the full window without a page scroll or Page tools", async (t) => {
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const { width, height } of [
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ])
    await t.test(`${width}x${height}`, async (t) => {
      const page = await browser.newPage({ viewport: { width, height } });
      t.after(() => page.close());
      await page.request.post(`${server.origin}/api/test/seed`, {
        data: { namespace: `shell-room-${width}`, viewer: "joe", reset: true },
      });
      for (const path of pages) {
        await page.goto(`${server.origin}${path}`);
        await page.locator("#appLayout").waitFor({ state: "attached" });
        const room = await page.evaluate(() => {
          const main = document.getElementById("appMainSlot");
          if (!main) throw Error("no main region");
          const box = main.getBoundingClientRect();
          return {
            bottomBand: innerHeight - box.bottom,
            mainTop: box.top + Number.parseFloat(getComputedStyle(main).paddingTop),
            pageScroll: document.documentElement.scrollHeight - innerHeight,
            pageTools: document.querySelector(".app-layout-page-tools") !== null,
            title: document.querySelector(".app-layout-topbar .app-layout-title")?.textContent?.trim(),
          };
        });
        assert.ok(room.bottomBand <= 28, `${path} bottom band ${room.bottomBand}px`);
        assert.ok(room.mainTop <= 112, `${path} main view starts at ${room.mainTop}px`);
        assert.equal(room.pageScroll, 0, `${path} scrolls inside the main region, not the page`);
        assert.equal(room.pageTools, false, `${path} has no Page tools`);
        assert.ok(room.title, `${path} names itself in the top bar`);
      }
    });
});

test("The workspace sidebar starts closed and its toggle opens it", async (t) => {
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "shell-sidebar", viewer: "joe", reset: true },
  });
  await page.goto(`${server.origin}/clients`);
  const layout = page.locator("#appLayout");
  await layout.waitFor({ state: "attached" });
  assert.equal(await layout.getAttribute("data-sidebar"), "closed");
  await page.getByRole("button", { name: "Workspace sidebar" }).click();
  assert.equal(await layout.getAttribute("data-sidebar"), "open");
  assert.ok(await page.locator("#appSidebar").isVisible());
});

test("Former Page tools controls sit in the toolbar row", async (t) => {
  const server = await (await createQaServer()).start();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  await page.request.post(`${server.origin}/api/test/seed`, {
    data: { namespace: "shell-tools", viewer: "joe", reset: true },
  });
  for (const [path, control] of [
    ["/relationships", "#networkSearch"],
    ["/invoices", "#invoiceOwner"],
    ["/clients", "#refreshList"],
  ]) {
    await page.goto(`${server.origin}${path}`);
    await page.locator("#appLayout").waitFor({ state: "attached" });
    assert.ok(await page.locator(`#appToolsSlot ${control}`).isVisible(), `${path} keeps ${control}`);
  }
});
