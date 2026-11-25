import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/clients-first-screen";
await mkdir(shots, { recursive: true });

async function openClients(t: TestContext, width: number, height: number) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.clock.install({ time: new Date("2026-10-01T18:00:00Z") });
  const listReads: URL[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/api/v1/business/clients") listReads.push(url);
    return r.fulfill({ json: directoryFixture(url.href) });
  });
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "{}" }] } },
    });
  });
  await page.goto(`${server.url}/clients`);
  await page.locator(".record-row").first().waitFor();
  return { page, listReads };
}

const firstScreen = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
    const rows = [...document.querySelectorAll(".record-row")].map((row) => row.getBoundingClientRect());
    return {
      pageScrolls: document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      listTop: Math.round(box("#recordList").top),
      listWidth: Math.round(box("#recordList").width),
      mainWidth: Math.round(box("#main").width),
      wholeRows: rows.filter((row) => row.top >= 0 && row.bottom <= innerHeight).length,
    };
  });

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const)
  test(`the Clients list fills the first screen at ${width}x${height}`, async (t) => {
    const { page } = await openClients(t, width, height);
    await page.screenshot({ path: `${shots}/clients-${width}.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.listTop <= 112, `the list starts near the top, not at ${fit.listTop}px`);
    assert.ok(fit.listWidth >= fit.mainWidth - 48, `the list is ${fit.listWidth}px of a ${fit.mainWidth}px page`);
    assert.ok(fit.wholeRows >= 8, `at least eight clients show whole, not ${fit.wholeRows}`);
    const before = {
      search: await page.locator("#searchInput").boundingBox(),
      row: await page.locator(".record-row").first().boundingBox(),
    };
    await page.mouse.move(width / 2, height - 100);
    await page.mouse.wheel(0, 300);
    await page.waitForFunction(
      (top) => (document.querySelector(".record-row")?.getBoundingClientRect().top ?? top) < top - 100,
      before.row?.y ?? 0,
    );
    assert.equal(await page.evaluate(() => scrollY), 0, "the list scrolls, not the page");
    assert.deepEqual(await page.locator("#searchInput").boundingBox(), before.search, "the toolbar stays in place");
  });

test("a Clients filter applies as it changes and Clear undoes it", async (t) => {
  const { page, listReads } = await openClients(t, 1280, 800);
  const toolbar = page.getByRole("form", { name: "Search and filter" });
  assert.equal(await page.getByRole("button", { name: "Apply" }).count(), 0, "there is no Apply button");
  assert.equal(await page.getByRole("button", { name: "Reset" }).count(), 0, "there is no Reset button");
  const clear = page.getByRole("button", { name: "Clear", exact: true });
  assert.equal(await clear.isVisible(), false, "Clear hides while nothing is filtered");
  await toolbar.getByLabel("Status").selectOption("active");
  await page.waitForURL(/status=active/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(listReads.at(-1)?.searchParams.get("status"), "active", "the list is read with the new status");
  assert.ok(await clear.isVisible(), "Clear shows once a filter is set");
  await page.screenshot({ path: `${shots}/clients-filtered-1280.png` });
  await clear.click();
  await page.waitForURL((url) => !url.search.includes("status="));
  assert.equal(await toolbar.getByLabel("Status").inputValue(), "", "Status returns to Any status");
  assert.equal(await clear.isVisible(), false, "Clear hides again");
});

test("search, the filters, sort, refresh and Clear share one toolbar row", async (t) => {
  const { page } = await openClients(t, 1280, 800);
  const filters = page.getByRole("form", { name: "Search and filter" });
  await filters.getByLabel("Pipeline").selectOption({ index: 1 });
  await page.getByRole("button", { name: "Clear", exact: true }).waitFor();
  const controls = [page.getByRole("searchbox", { name: "Search" })];
  controls.push(
    ...["Status", "Client type", "Pipeline", "Sort"].map((label) => filters.getByLabel(label, { exact: true })),
  );
  controls.push(
    page.getByRole("button", { name: "Refresh", exact: true }),
    page.getByRole("button", { name: "Clear", exact: true }),
  );
  const middles = await Promise.all(
    controls.map(async (control) => {
      const box = await control.boundingBox();
      return box ? box.y + box.height / 2 : Number.NaN;
    }),
  );
  assert.ok(Math.max(...middles) - Math.min(...middles) < 8, `the controls sit on one row: ${middles.join(", ")}`);
  const joe = await page
    .getByRole("group", { name: "Record scope" })
    .getByRole("button", { name: "Joe" })
    .boundingBox();
  assert.ok(joe && joe.y + joe.height <= Math.min(...middles), "the owner chips sit above, beside the page title");
});

test("Clients stays usable on a phone", async (t) => {
  const { page } = await openClients(t, 390, 844);
  await page.screenshot({ path: `${shots}/clients-390.png` });
  assert.equal((await firstScreen(page)).sideways, false, "nothing scrolls sideways");
  assert.equal(await page.getByRole("button", { name: "Apply" }).count(), 0, "there is no Apply button");
  const row = await page.locator(".record-row").first().boundingBox();
  assert.ok(row && row.y <= 260, `filters fold away so the first client starts at ${row?.y}px`);
  await page.getByText("Filters and sort").click();
  await page.getByRole("form", { name: "Search and filter" }).getByLabel("Status").selectOption("active");
  await page.waitForURL(/status=active/);
  assert.equal((await firstScreen(page)).sideways, false, "open filters fit the width");
  await page.screenshot({ path: `${shots}/clients-390-filters.png` });
  await page.locator(".record-row").first().click();
  await page.getByRole("dialog").getByRole("heading", { name: "Demo Practice 01" }).waitFor();
});
