import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/vendor-tiles";
await mkdir(shots, { recursive: true });

type Counts = { count: number; quiet: number; relationship: Record<string, number> };
type Summary = { all: Counts; no_category: Counts; categories: ({ slug: string; label: string } & Counts)[] };

// Three made-up vendors nobody categorized, so the No category tile shows.
function withUncategorized(url: string) {
  const payload = directoryFixture(url);
  if (!new URL(url).pathname.endsWith("/summary")) return payload;
  // The fixture is declared as a loose record; its summary answer carries the tile counts.
  const summary = payload as unknown as Summary;
  summary.no_category = { count: 3, quiet: 0, relationship: { ...summary.all.relationship, not_rated: 3 } };
  return summary;
}

async function openVendors(
  t: TestContext,
  width: number,
  height: number,
  { path = "/vendors", live = false, light = false, ready = ".vendor-tile[href]" } = {},
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

const tileNames = (page: import("playwright").Page) => page.locator("a.vendor-tile .tile-name").allTextContents();

test("Vendors opens on a tile per category that opens its list, and Joe recounts them", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900);
  assert.deepEqual(
    await tileNames(page),
    ["All vendors", "Architecture", "Banking", "No category"],
    "empty Attorney has no tile",
  );
  assert.equal(await page.locator(".record-row").count(), 0, "no list under the tiles");
  const all = page.locator("a.vendor-tile").first();
  assert.equal(await all.locator(".tile-count").textContent(), "62");
  assert.equal(await page.locator("#resultSummary").textContent(), "62 vendors");
  assert.match((await all.locator(".tile-quiet").textContent()) ?? "", /^\d+ quiet$/);
  assert.ok(await all.locator('.tile-mix [data-relationship="core"]').isVisible());
  await page.screenshot({ path: `${shots}/tiles-1440.png` });

  await page.getByRole("button", { name: "Joe", exact: true }).click();
  await page.waitForURL(/owner=joe/);
  await page.waitForFunction(() => document.querySelector(".vendor-tile .tile-count")?.textContent === "31");
  assert.equal(asked.at(-1)?.search, "?owner=joe");

  await page.locator("a.vendor-tile", { hasText: "Banking" }).click();
  await page.waitForURL(/category=banker/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#vendorTiles").isHidden(), true);
  const list = asked.at(-1);
  assert.equal(list?.searchParams.get("category"), "banker");
  assert.equal(list?.searchParams.get("owner"), "joe");

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.waitForURL((url) => url.pathname === "/vendors" && url.search === "?owner=joe");
  await page.locator("a.vendor-tile", { hasText: "No category" }).click();
  await page.waitForURL(/no_category=true/);
  await page.waitForFunction(() => document.querySelector("#vendorTiles")?.hasAttribute("hidden"));
  assert.equal(asked.at(-1)?.searchParams.get("no_category"), "true");

  await page.goBack();
  await page.locator("a.vendor-tile", { hasText: "All vendors" }).click();
  await page.waitForURL(/all=true/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(asked.at(-1)?.searchParams.has("all"), false, "All vendors is the plain list read");
});

test("Find a vendor swaps the tiles for matches and clearing it brings them back", async (t) => {
  const { page } = await openVendors(t, 1280, 640);
  await page.screenshot({ path: `${shots}/tiles-1280x640.png` });
  const find = page.getByPlaceholder("Find a vendor");
  await find.fill("Partner 0");
  await page.waitForURL(/q=Partner/);
  await page.locator(".record-row").first().waitFor();
  assert.equal(await page.locator("#vendorTiles").isHidden(), true);
  await find.fill("");
  await page.waitForURL((url) => !url.searchParams.has("q"));
  await page.locator(".vendor-tile[href]").first().waitFor();
  assert.equal(await page.locator("#listRegion").isHidden(), true);
});

test("on a phone the tiles are two across", async (t) => {
  const { page } = await openVendors(t, 390, 844);
  const boxes = await page
    .locator("a.vendor-tile")
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
  assert.equal(await page.locator("#vendorTiles").isHidden(), true);
  assert.equal(asked.at(-1)?.searchParams.get("scope"), "mine");
});

test("a refresh keeps keyboard focus on the same tile", async (t) => {
  const { page, asked } = await openVendors(t, 1440, 900);
  const tile = page.locator("a.vendor-tile", { hasText: "Banking" });
  const href = await tile.getAttribute("href");
  await tile.focus();
  const reads = asked.length;
  await page.evaluate(() => document.querySelector<HTMLButtonElement>("#refreshList")?.click());
  await page.waitForFunction((n) => n > 0, reads);
  await page.waitForFunction(() => document.querySelector("#vendorTiles")?.getAttribute("aria-busy") === "false");
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
