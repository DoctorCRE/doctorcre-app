import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = process.env.CLIENT_TILES_SHOTS ?? "out/test-artifacts/client-tiles";
await mkdir(shots, { recursive: true });

const mix = (total: number, open_deal: number, past_client: number) => ({
  total,
  open_deal,
  past_client,
  no_deal_yet: total - open_deal - past_client,
});
// Made-up counts; Dell owns a third of each.
const tilesFor = (owner: string | null) => {
  const n = (count: number) => (owner === "dell" ? Math.floor(count / 3) : count);
  return {
    all: mix(n(120), n(12), n(30)),
    national_accounts: { accounts: 1, ...mix(n(9), n(3), 0) },
    practice_types: [
      { practice_type: "Dental", ...mix(n(64), n(6), n(18)) },
      { practice_type: "Veterinary", ...mix(n(21), n(3), n(6)) },
      { practice_type: "Physical Therapy", ...mix(n(12), 0, n(3)) },
    ],
    not_set: mix(n(23), n(3), n(3)),
  };
};

async function openClients(t: TestContext, width: number, height: number, theme = "dark") {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((saved) => localStorage.setItem("dealroom-theme", saved), theme);
  const asked: URL[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/api/v1/business/clients") asked.push(url);
    // The fixture is declared as a loose record; the tiles ride beside its list answer.
    const payload = directoryFixture(url.href) as Record<string, unknown>;
    if (url.searchParams.get("tiles") === "true") {
      payload.tiles = tilesFor(url.searchParams.get("owner"));
    }
    return r.fulfill({ json: payload });
  });
  await page.route("**/mcp", (r) => r.fulfill({ json: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
  await page.goto(`${server.url}/clients`);
  await page.locator("a.directory-tile").first().waitFor();
  return { page, asked };
}

const tileNames = (page: Page) => page.locator("a.directory-tile .tile-name").allTextContents();
const countOf = (page: Page, name: string) =>
  page
    .locator("a.directory-tile", { has: page.locator(".tile-name", { hasText: name }) })
    .locator(".tile-count")
    .textContent();

test("Clients opens on tiles in the approved order, and a tile opens its clients", async (t) => {
  const { page, asked } = await openClients(t, 1440, 772);
  assert.deepEqual(await tileNames(page), [
    "All clients",
    "National Accounts",
    "Dental",
    "Veterinary",
    "Physical Therapy",
    "Not set",
  ]);
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");
  assert.equal(await countOf(page, "All clients"), "120");
  assert.equal(await countOf(page, "National Accounts"), "1", "one account");
  assert.equal(await page.locator("#resultSummary").textContent(), "120 clients");
  const dental = page.locator("a.directory-tile", { hasText: "Dental" });
  assert.deepEqual(await dental.locator(".tile-mix li").allTextContents(), [
    "6 Open deal",
    "18 Past client",
    "40 No deal yet",
  ]);
  assert.equal(
    await page.locator("a.directory-tile", { hasText: "National Accounts" }).locator(".tile-foot").textContent(),
    "9 locations",
  );
  assert.equal(asked.at(-1)?.searchParams.get("tiles"), "true");
  assert.equal(
    await page.evaluate(() => document.documentElement.scrollHeight > innerHeight),
    false,
    "one screen tall",
  );
  await page.screenshot({ path: `${shots}/dj-cl-a2-1440x772-dark.png` });

  await page.getByRole("button", { name: "Dell", exact: true }).click();
  await page.waitForURL(/owner=dell/);
  await page.waitForFunction(() => document.querySelector("a.directory-tile .tile-count")?.textContent === "40");
  assert.equal(asked.at(-1)?.searchParams.get("owner"), "dell");

  await dental.click();
  await page.waitForURL(/practice_type=Dental/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  const list = asked.at(-1);
  assert.equal(list?.searchParams.get("practice_type"), "Dental");
  assert.equal(list?.searchParams.get("owner"), "dell");
  assert.equal(list?.searchParams.has("tiles"), false);

  for (const [name, url, key, value] of [
    ["Not set", /not_set=true/, "practice_type", ""],
    ["National Accounts", /national_account=any/, "national_account", "any"],
  ] as const) {
    await page.goBack();
    await page.locator("a.directory-tile", { hasText: name }).click();
    await page.waitForURL(url);
    await page.locator(".record-row").first().waitFor();
    assert.equal(asked.at(-1)?.searchParams.get(key), value);
  }

  await page.goBack();
  await page.locator("a.directory-tile", { hasText: "All clients" }).click();
  await page.waitForURL(/all=true/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(asked.at(-1)?.searchParams.has("all"), false, "All clients is the plain list read");
});

test("Find a client searches every tile and clearing it brings the tiles back", async (t) => {
  const { page, asked } = await openClients(t, 1280, 640);
  await page.screenshot({ path: `${shots}/dj-cl-a2-1280x640-dark.png` });
  const find = page.getByPlaceholder("Find a client");
  await find.fill("Demo Practice");
  await page.waitForURL(/q=Demo/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  assert.equal(asked.at(-1)?.searchParams.has("practice_type"), false);
  await find.fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  await page.locator("a.directory-tile").first().waitFor();
  assert.equal(await page.locator("#listRegion").isHidden(), true);
});

test("On a phone the tiles are two across with the name and the number", async (t) => {
  const { page } = await openClients(t, 390, 844);
  const tops = await page
    .locator("a.directory-tile")
    .evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top));
  assert.equal(tops[0], tops[1], "the first two tiles share a row");
  assert.equal(await page.locator(".tile-mix").first().isVisible(), false);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: `${shots}/dj-cl-a2-390-dark.png`, fullPage: true });
});

test("Light theme", async (t) => {
  for (const [width, height] of [
    [1440, 772],
    [1280, 640],
    [390, 844],
  ] as const) {
    const { page } = await openClients(t, width, height, "light");
    await page.screenshot({
      path: `${shots}/dj-cl-a2-${width === 390 ? "390" : `${width}x${height}`}-light.png`,
      fullPage: width === 390,
    });
  }
});
