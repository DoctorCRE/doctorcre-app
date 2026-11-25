import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const meetings = JSON.parse(
  await readFile(new URL("./fixtures/vendor-meetings/recordings.json", import.meta.url), "utf8"),
).research;
meetings.items[0].vendor_id = "00000000-0000-4000-8000-000000000001";
const shots = "out/test-artifacts/vendors-fit";
await mkdir(shots, { recursive: true });

type Relationship = { deals_referred: number; deals_worked: number } | null;
// Vendors with no recorded deal history: the engine sends every count as 0.
function withoutHistory(url: string) {
  const payload = directoryFixture(url);
  // The fixture is declared as a loose record; its list payload carries vendor rows.
  for (const row of (payload.rows ?? []) as { relationship: Relationship }[])
    if (row.relationship)
      Object.assign(row.relationship, { deals_referred: 0, deals_worked: 0, won: 0, lost: 0, win_rate: null });
  return payload;
}

async function openVendors(t: TestContext, width: number, height: number, today?: "open") {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.clock.install({ time: new Date("2026-10-01T18:00:00Z") });
  if (today) await page.addInitScript((state) => localStorage.setItem("doctorcre:today:/vendors", state), today);
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: withoutHistory(r.request().url()) }));
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    const payload = request.params.name === "read-vendor-meetings" ? meetings : {};
    return route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
    });
  });
  await page.goto(`${server.url}/vendors`);
  await page.locator(".record-row").first().waitFor();
  await page.getByRole("button", { name: "Show quiet vendors" }).waitFor();
  return page;
}

const firstScreen = (page: Page) =>
  page.evaluate(() => {
    const rows = [...document.querySelectorAll(".record-row")].map((row) => row.getBoundingClientRect());
    return {
      pageScrolls: document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      listTop: Math.round(document.querySelector("#recordList")?.getBoundingClientRect().top ?? 0),
      wholeRows: rows.filter((row) => row.top >= 0 && row.bottom <= innerHeight).length,
    };
  });

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const)
  test(`the Vendors list fills the first screen at ${width}x${height}`, async (t) => {
    const page = await openVendors(t, width, height);
    await page.screenshot({ path: `${shots}/vendors-${width}.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.listTop <= 112, `the list starts near the top, not at ${fit.listTop}px`);
    assert.ok(fit.wholeRows >= 12, `at least twelve vendors show whole, not ${fit.wholeRows}`);
  });

test("the Vendors list fits beside an open Today at 1280x800", async (t) => {
  const page = await openVendors(t, 1280, 800, "open");
  await page.screenshot({ path: `${shots}/vendors-1280-today.png` });
  const fit = await firstScreen(page);
  assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
  assert.equal(fit.sideways, false, "nothing scrolls sideways");
  assert.ok(fit.listTop <= 160, `the toolbar takes at most two lines, list at ${fit.listTop}px`);
  const broken = await page.evaluate(() =>
    [...document.querySelectorAll(".record-row .fact-value")]
      .filter((value) => {
        const range = document.createRange();
        range.selectNodeContents(value);
        return range.getClientRects().length > 1;
      })
      .map((value) => value.textContent),
  );
  assert.deepEqual(broken, [], "every fact reads on one line");
});

test("Vendors stays usable on a phone", async (t) => {
  const page = await openVendors(t, 390, 844);
  await page.screenshot({ path: `${shots}/vendors-390.png` });
  assert.equal((await firstScreen(page)).sideways, false, "nothing scrolls sideways");
  const row = await page.locator(".record-row").first().boundingBox();
  const nav = await page.locator("#appShell").boundingBox();
  assert.ok(row && nav && row.y + row.height <= nav.y, "the first vendor is whole on the first screen");
});

test("vendor rows leave out deal counts that no history backs", async (t) => {
  const page = await openVendors(t, 1440, 900);
  const row = (await page.locator(".record-row").first().textContent()) ?? "";
  assert.match(row, /CategoryBanking/);
  assert.doesNotMatch(row, /Referred|Worked|Win rate/);
});

test("People worth meeting is a tab beside the list", async (t) => {
  const page = await openVendors(t, 1280, 800);
  const meetings = page.getByRole("region", { name: "People worth meeting" });
  assert.equal(await meetings.isVisible(), false, "the list opens first");
  await page.getByRole("button", { name: "People worth meeting", exact: true }).click();
  await meetings.getByText("Ada Synthetic", { exact: true }).waitFor();
  assert.equal(await page.locator("#recordList").isVisible(), false, "the list steps aside");
  const panel = await meetings.boundingBox();
  assert.ok(panel && panel.y <= 112, `the panel starts near the top, not at ${panel?.y}px`);
  await page.screenshot({ path: `${shots}/meetings-1280.png` });
  await page.getByRole("button", { name: "List", exact: true }).click();
  await page.locator(".record-row").first().waitFor();
});
