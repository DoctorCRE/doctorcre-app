import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { expect } from "@playwright/test";
import type { Locator, Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/directory-tiles";
await mkdir(shots, { recursive: true });

type Counts = { count: number; quiet: number; relationship: Record<string, number> };
type Summary = { all: Counts; no_category: Counts; categories: ({ slug: string; label: string } & Counts)[] };

// Three made-up vendors nobody categorized, so the No category tile shows.
function withUncategorized(url: string) {
  const payload = directoryFixture(url);
  const request = new URL(url);
  if (request.pathname === "/api/v1/business/vendors") {
    // The fixture returns a loose record; this route carries the vendor list.
    const list = payload as {
      rows: { name: string; recorded_category: string | null; categories: unknown[] }[];
      total: number;
      page_count: number;
      page_size: number;
    };
    if (request.searchParams.has("no_category")) {
      const source = new URL(url);
      source.searchParams.delete("no_category");
      // Removing the filter asks the same fixture for its vendor list.
      const all = directoryFixture(source.toString()) as typeof list;
      list.rows = all.rows.slice(0, 3).map((row) => ({ ...row, recorded_category: null, categories: [] }));
      list.page_size = 3;
      list.total = 3;
      list.page_count = 1;
    }
    return list;
  }
  if (!request.pathname.endsWith("/summary")) return payload;
  // The fixture is declared as a loose record; its summary answer carries the tile counts.
  const summary = payload as unknown as Summary;
  summary.no_category = { count: 3, quiet: 0, relationship: { ...summary.all.relationship, not_rated: 3 } };
  return summary;
}

async function openVendors(
  t: TestContext,
  width: number,
  height: number,
  { path = "/vendors", live = false, light = false, ready = ".directory-tile[href]" } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: light ? "light" : "dark" });
  if (light)
    await page.addInitScript(() =>
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" })),
    );
  const asked: URL[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => {
    asked.push(new URL(r.request().url()));
    return r.fulfill({ json: withUncategorized(r.request().url()) });
  });
  await page.route("**/mcp", (r) =>
    r.fulfill({
      json: { jsonrpc: "2.0", id: r.request().postDataJSON()?.id, result: { content: [{ type: "text", text: "{}" }] } },
    }),
  );
  if (live) {
    await page.route("**/auth/session", (r) =>
      r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
    );
    await page.route(
      (url) => url.pathname === "/vendors",
      async (r) => {
        const response = await r.fetch();
        return r.fulfill({
          response,
          body: (await response.text()).replace("<html ", "<html data-clients-vendors-from-engine "),
        });
      },
    );
  }
  await page.goto(`${server.url}${path}${live ? `${path.includes("?") ? "&" : "?"}mode=live` : ""}`);
  await page.locator(ready).first().waitFor();
  return { page, asked };
}

const tileNames = (page: import("playwright").Page) => page.locator("a.directory-tile .tile-name").allTextContents();
const names = (numbers: number[]) => numbers.map((n) => `Demo Partner ${String(n).padStart(2, "0")}`);
const banker = Array.from({ length: 31 }, (_, n) => n * 2 + 1);
const defaultBanker = [
  1, 11, 21, 31, 51, 61, 7, 17, 27, 37, 47, 57, 3, 13, 23, 33, 43, 53, 9, 29, 39, 49, 59, 5, 15, 25, 35, 55, 45, 19, 41,
];

async function clickList(page: Page, control: Locator, query: string, expected: string[]) {
  const response = page.waitForResponse((r) => {
    const url = new URL(r.url());
    const actual = new URLSearchParams(url.search);
    const wanted = new URLSearchParams(query);
    actual.sort();
    wanted.sort();
    return url.pathname === "/api/v1/business/vendors" && actual.toString() === wanted.toString();
  });
  await control.click();
  await response;
  await expect(page.locator(".record-row:visible .row-name")).toHaveText(expected);
}

test("Vendors opens on a tile per category that opens its list, and Joe recounts them", async (t) => {
  const { page } = await openVendors(t, 1440, 900);
  assert.deepEqual(
    await tileNames(page),
    ["All vendors", "Architecture", "Banking", "No category"],
    "empty Attorney has no tile",
  );
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");
  const all = page.locator("a.directory-tile").first();
  assert.equal(await all.locator(".tile-count").textContent(), "62");
  assert.equal(await page.locator("#resultSummary").textContent(), "62 vendors");
  assert.match((await all.locator(".tile-quiet").textContent()) ?? "", /^\d+ quiet$/);
  assert.ok(await all.locator('.tile-mix [data-relationship="core"]').isVisible());
  await page.screenshot({ path: `${shots}/tiles-1440.png` });

  await page.getByRole("button", { name: "Joe", exact: true }).click();
  await page.waitForURL(/owner=joe/);
  await page.waitForFunction(() => document.querySelector(".directory-tile .tile-count")?.textContent === "31");

  await clickList(
    page,
    page.locator("a.directory-tile", { hasText: "Banking" }),
    "owner=joe&category=banker&contract=vendor-directory.v1",
    names(defaultBanker),
  );
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.locator("a.directory-tile", { hasText: "No category" }).waitFor();
  await clickList(
    page,
    page.locator("a.directory-tile", { hasText: "No category" }),
    "owner=joe&no_category=true&contract=vendor-directory.v1",
    names([1, 11, 21]),
  );
  await page.goBack();
  await page.locator("a.directory-tile", { hasText: "All vendors" }).waitFor();
  await clickList(
    page,
    page.locator("a.directory-tile", { hasText: "All vendors" }),
    "owner=joe&contract=vendor-directory.v1",
    names(defaultBanker.slice(0, 25)),
  );
});

test("Find a vendor swaps the tiles for matches and clearing it brings them back", async (t) => {
  const { page } = await openVendors(t, 1280, 640);
  await page.screenshot({ path: `${shots}/tiles-1280x640.png` });
  const find = page.getByPlaceholder("Find a vendor");
  await find.fill("Partner 0");
  await page.waitForURL(/q=Partner/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  await find.fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  await page.locator(".directory-tile[href]").first().waitFor();
  assert.equal(await page.locator("#listRegion").isHidden(), true);
});

test("on a phone the tiles are two across", async (t) => {
  const { page } = await openVendors(t, 390, 844);
  const boxes = await page
    .locator("a.directory-tile")
    .evaluateAll((tiles) => tiles.slice(0, 2).map((tile) => tile.getBoundingClientRect().top));
  assert.equal(boxes[0], boxes[1], "the first two tiles share a row");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const dell = await page.getByRole("button", { name: "Dell", exact: true }).boundingBox();
  assert.ok(dell && dell.x + dell.width <= 390, "the owner chips fit beside Categories");
  await page.screenshot({ path: `${shots}/tiles-390.png`, fullPage: true });
});

test("New vendor offers every category while the tiles are showing (Edit reads the same list)", async (t) => {
  const { page } = await openVendors(t, 1440, 900, { live: true });
  await page.getByRole("button", { name: "New vendor" }).click();
  const dialog = page.getByRole("dialog", { name: "New vendor" });
  const choices = await dialog.locator('input[name="categories"]').count();
  assert.ok(choices >= 3, `the form lists the categories (${choices})`);
  assert.equal(await dialog.getByText("No categories yet.").count(), 0);
});

test("a saved link to My work keeps showing the vendors recorded as yours", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, { path: "/vendors?scope=mine", ready: ".record-row" });
  assert.equal(await page.locator("#directoryTiles").isHidden(), true);
  assert.equal(asked.at(-1)?.searchParams.get("scope"), "mine");
});

test("a refresh keeps keyboard focus on the same tile", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900);
  const tile = page.locator("a.directory-tile", { hasText: "Banking" });
  const href = await tile.getAttribute("href");
  await tile.focus();
  const reads = asked.length;
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#refreshList")?.click());
  await page.waitForFunction((n) => n > 0, reads);
  await page.waitForFunction(() => document.querySelector("#directoryTiles")?.getAttribute("aria-busy") === "false");
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute("href")), href);
});

for (const width of [390, 320])
  test(`the top row keeps Joe, Dell and New vendor on screen at ${width}`, async (t) => {
    const { page } = await openVendors(t, width, 844, { live: true, light: true });
    await page.getByRole("button", { name: "New vendor" }).waitFor();
    await page.screenshot({ path: `${shots}/tiles-new-${width}.png`, fullPage: true });
    for (const name of ["New vendor", "Joe", "Dell"]) {
      const box = await page.getByRole("button", { name, exact: true }).boundingBox();
      assert.ok(box && box.x >= 0 && box.x + box.width <= width, `${name} sits inside ${width} wide`);
    }
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  });

test("inside a category the relationship counts and Quiet filter the one table, and headings sort it", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900, { path: "/vendors?category=banker", ready: ".record-row" });
  const reads = () => asked.filter((url) => url.pathname.endsWith("/vendors")).length;
  const counts = page.locator("#tableFilters [data-relationship-filter]");
  const total = await page.locator(".record-row").count();
  assert.equal(total, 31, "the whole category in one table");
  assert.equal(await page.locator("#resultSummary").textContent(), "Banking · 31 vendors");
  const core = counts.filter({ hasText: "Core" });
  const shown = Number(await core.locator(".tile-n").textContent());
  const before = reads();
  await core.click();
  await page.waitForURL(/relationship=core/);
  assert.equal(await page.locator(".record-row").count(), shown, "only Core vendors");
  assert.equal(await core.getAttribute("aria-pressed"), "true");
  assert.equal(reads(), before, "the filter re-reads nothing");
  await core.click();
  await page.waitForURL((url) => !url.searchParams.has("relationship"));
  assert.equal(await page.locator(".record-row").count(), total);

  const quiet = page.getByRole("button", { name: /^Quiet/ });
  const quietRows = await page.locator(".record-row .contact-note.quiet").count();
  assert.ok(quietRows > 0, "the category holds quiet vendors");
  assert.equal(await quiet.locator(".tile-n").textContent(), String(quietRows), "Quiet counts the quiet vendors");
  await clickList(
    page,
    quiet,
    "category=banker&quiet=true&contract=vendor-directory.v1",
    names(defaultBanker.filter((n) => (n - 1) % 4 === 0)),
  );
  assert.equal(await page.locator(".record-row .contact-note:not(.quiet)").count(), 0);
  await clickList(page, quiet, "category=banker&contract=vendor-directory.v1", names(defaultBanker));
  const nameHeading = page.locator('[data-column-sort="name"]');
  await clickList(page, nameHeading, "category=banker&sort=name&contract=vendor-directory.v1", names(banker));
  assert.equal(await nameHeading.getAttribute("aria-pressed"), "true");
  await clickList(page, nameHeading, "category=banker&contract=vendor-directory.v1", names(defaultBanker));
  assert.equal(await page.locator(".list-head [data-fact=Category]").count(), 0, "no Category column inside one");
});

test("outside a category the relationship counts and the Quiet count stay away, however small the answer", async (t) => {
  const { page } = await openVendors(t, 1440, 900, { path: "/vendors?all=true&q=Partner+0", ready: ".record-row" });
  assert.equal(await page.locator("#tableFilters [data-relationship-filter]").count(), 0);
  assert.equal(await page.getByRole("button", { name: /^Quiet/ }).textContent(), "Quiet");
});

test("a filter that matches nothing says so and Clear filters brings the category back", async (t) => {
  const { page } = await openVendors(t, 1280, 640, {
    path: "/vendors?category=banker&q=Nobody",
    ready: ".record-empty",
  });
  await page.getByRole("button", { name: "Clear filters" }).click();
  await page.waitForURL((url) => url.search === "?category=banker");
  await page.locator(".record-row").first().waitFor();
});

for (const width of [320, 390])
  test(`at ${width} wide a tile's count stays inside its tile`, async (t) => {
    const { page } = await openVendors(t, width, 740);
    const touching = await page.locator("a.directory-tile").evaluateAll((tiles) =>
      tiles
        .filter((tile) => {
          const count = tile.querySelector(".tile-count")?.getBoundingClientRect();
          return count && count.right > tile.getBoundingClientRect().right - 8;
        })
        .map((tile) => tile.querySelector(".tile-name")?.textContent),
    );
    assert.deepEqual(touching, []);
  });
