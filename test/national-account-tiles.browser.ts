import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = process.env.NATIONAL_ACCOUNT_SHOTS ?? "out/test-artifacts/national-account-tiles";
const ACCOUNT = "0d9e3a4c-0000-4000-8000-00000000a001";
const QUIET = "0d9e3a4c-0000-4000-8000-00000000a002";

const mix = (total: number, open_deal: number, past_client: number) => ({
  total,
  open_deal,
  past_client,
  no_deal_yet: total - open_deal - past_client,
});
// Made-up counts: Demo Music Studios has six locations, Demo Quiet Brand none of Dell's.
const accountCounts = (account: string | null, owner: string | null) =>
  account === ACCOUNT
    ? mix(owner === "dell" ? 2 : 6, 1, owner === "dell" ? 0 : 2)
    : owner === "dell"
      ? mix(0, 0, 0)
      : mix(3, 0, 1);
const tilesFor = (account: string | null, owner: string | null) => {
  const locations =
    account === null || account === "any"
      ? mix(owner === "dell" ? 2 : 9, 1, owner === "dell" ? 0 : 3)
      : accountCounts(account, owner);
  return {
    all: mix(120, 12, 30),
    national_accounts: { accounts: account === null || account === "any" ? 2 : 1, ...locations },
    practice_types: [{ practice_type: "Dental", ...mix(120, 12, 30) }],
    not_set: mix(0, 0, 0),
  };
};

async function openClients(t: TestContext, path: string, width = 1440, height = 900, theme = "dark") {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.addInitScript((saved) => localStorage.setItem("dealroom-theme", saved), theme);
  const asked: URL[] = [];
  const served: { extra: number; hold: Promise<void> | null } = { extra: 0, hold: null };
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", async (r) => {
    const url = new URL(r.request().url());
    if (url.pathname === "/api/v1/business/clients") asked.push(url);
    // The fixture is declared as a loose record; the tiles ride beside its list answer.
    const payload = directoryFixture(url.href) as Record<string, unknown>;
    if (url.searchParams.get("tiles") === "true") {
      await served.hold;
      const tiles = tilesFor(url.searchParams.get("national_account"), url.searchParams.get("owner"));
      if (url.searchParams.get("national_account") === ACCOUNT) {
        tiles.national_accounts.total += served.extra;
        tiles.national_accounts.no_deal_yet += served.extra;
      }
      payload.tiles = tiles;
    }
    return r.fulfill({ json: payload });
  });
  await page.route("**/api/engine/deals?*", (r) =>
    r.fulfill({
      json: {
        deals: [],
        accounts: [
          { account_client_id: ACCOUNT, account_name: "Demo Music Studios", account_owner: "joe" },
          { account_client_id: QUIET, account_name: "Demo Quiet Brand", account_owner: "dell" },
        ],
      },
    }),
  );
  await page.route("**/mcp", (r) => r.fulfill({ json: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
  await page.goto(`${server.url}${path}`);
  return { page, asked, served };
}

const tile = (page: Page, name: string) =>
  page.locator("a.directory-tile", { has: page.locator(".tile-name", { hasText: name }) });

test("National Accounts opens a tile per account with its locations and owner, and an account opens its locations", async (t) => {
  const { page, asked } = await openClients(t, "/clients");
  await tile(page, "National Accounts").click();
  await page.waitForURL(/accounts=true/);
  await tile(page, "Demo Music Studios").waitFor();
  assert.deepEqual(await page.locator("a.directory-tile .tile-name").allTextContents(), [
    "All locations",
    "Demo Music Studios",
    "Demo Quiet Brand",
  ]);
  const account = tile(page, "Demo Music Studios");
  assert.equal(await account.locator(".tile-count").textContent(), "6");
  assert.deepEqual(await account.locator(".tile-mix li").allTextContents(), [
    "1 Open deal",
    "2 Past client",
    "3 No deal yet",
  ]);
  assert.equal(await account.locator(".tile-foot").textContent(), "Owner Joe");
  assert.equal(await tile(page, "All locations").locator(".tile-count").textContent(), "9");
  assert.equal(await page.locator("#placeBack").textContent(), "Clients");
  assert.equal(await page.locator("#accountsBack").isHidden(), true);
  assert.equal(await page.locator("#resultSummary").textContent(), "National Accounts · 2 accounts");
  assert.equal(await page.locator("#searchInput").getAttribute("placeholder"), "Find a client");
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");

  await page.getByRole("button", { name: "Dell", exact: true }).click();
  await page.waitForURL(/owner=dell/);
  await page.waitForFunction(() => document.querySelectorAll("a.directory-tile").length === 2);
  assert.equal(await tile(page, "Demo Music Studios").locator(".tile-count").textContent(), "2");
  assert.equal(await tile(page, "Demo Quiet Brand").count(), 0, "an account with none of Dell's locations has no tile");

  await tile(page, "Demo Music Studios").click();
  await page.waitForURL(new RegExp(`national_account=${ACCOUNT}`));
  await page.locator(".record-row").first().waitFor();
  const list = asked.filter((url) => !url.searchParams.has("tiles")).at(-1);
  assert.equal(list?.searchParams.get("national_account"), ACCOUNT);
  assert.equal(list?.searchParams.get("owner"), "dell");
  assert.equal(await page.locator("#accountsBack").textContent(), "National Accounts");
  assert.match((await page.locator("#resultSummary").textContent()) ?? "", /^Demo Music Studios · /);
  assert.equal(await page.locator("#resultsTitle").textContent(), "Clients / National Accounts / Demo Music Studios");
  await page.locator("#tableFilters [data-status-filter]").first().waitFor();
  assert.deepEqual(await page.locator("#tableFilters [data-status-filter]").allTextContents(), [
    "Open deal 1",
    "No deal yet 1",
  ]);

  await page.locator("#accountsBack").click();
  await page.waitForURL(/accounts=true/);
  await tile(page, "All locations").click();
  await page.waitForURL(/national_account=any/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(asked.at(-1)?.searchParams.get("national_account"), "any");
  assert.match((await page.locator("#resultSummary").textContent()) ?? "", /^All locations · /);
});

test("An account tile's counts follow a refresh when the window regains focus and stay on screen while it runs", async (t) => {
  const { page, served } = await openClients(t, "/clients?accounts=true");
  const count = tile(page, "Demo Music Studios").locator(".tile-count");
  await count.waitFor();
  assert.equal(await count.textContent(), "6");

  let release = () => {};
  served.extra = 4;
  served.hold = new Promise((resolve) => {
    release = resolve;
  });
  await Promise.all([
    page.waitForRequest((request) => request.url().includes(`national_account=${ACCOUNT}`)),
    page.evaluate(() => window.dispatchEvent(new Event("focus"))),
  ]);
  assert.equal(await count.textContent(), "6", "the old tiles stay while the account reads run");
  assert.equal(await page.locator(".directory-tile-grid .skeleton-line").count(), 0, "no flash to skeletons");
  release();
  await page.waitForFunction(
    (name) =>
      [...document.querySelectorAll("a.directory-tile")]
        .find((el) => el.querySelector(".tile-name")?.textContent === name)
        ?.querySelector(".tile-count")?.textContent === "10",
    "Demo Music Studios",
  );
});

test("An account's link names the account and counts its chips", async (t) => {
  const { page } = await openClients(t, `/clients?national_account=${ACCOUNT}`, 1280, 640);
  await page.waitForFunction(() =>
    document.querySelector("#resultSummary")?.textContent?.startsWith("Demo Music Studios"),
  );
  await page.locator("#tableFilters [data-status-filter]").first().waitFor();
  assert.deepEqual(await page.locator("#tableFilters [data-status-filter]").allTextContents(), [
    "Open deal 1",
    "Past client 2",
    "No deal yet 3",
  ]);
});

test("The Status column uses the tiles' words, never Roster or Cold", async (t) => {
  const { page } = await openClients(t, "/clients?all=true");
  await page.locator(".record-row").first().waitFor();
  const words = new Set(
    await page
      .locator(".record-row")
      .evaluateAll((rows) =>
        rows.map((row) => row.querySelector('[data-fact="Status"] .fact-value')?.textContent?.trim() ?? ""),
      ),
  );
  assert.deepEqual([...words].sort(), ["No deal yet", "Open deal", "Past client"]);
});

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
  [390, 844],
] as const)
  for (const theme of ["dark", "light"])
    test(`National Accounts at ${width} in ${theme}`, async (t) => {
      const { page } = await openClients(t, "/clients?accounts=true", width, height, theme);
      await tile(page, "Demo Music Studios").waitFor();
      await page.screenshot({ path: `${shots}/tiles-${width}-${theme}.png`, fullPage: width === 390 });
      await tile(page, "Demo Music Studios").click();
      await page.locator(".record-row").first().waitFor();
      await page.locator("#tableFilters [data-status-filter]").first().waitFor();
      await page.screenshot({ path: `${shots}/locations-${width}-${theme}.png`, fullPage: width === 390 });
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
      const dell = await page.getByRole("button", { name: "Dell", exact: true }).boundingBox();
      assert.ok(dell && dell.x + dell.width <= width, "the owner chips stay in view beside the trail");
    });
