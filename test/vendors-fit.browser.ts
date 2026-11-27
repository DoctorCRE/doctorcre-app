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

type Relationship = { deals_referred: number; deals_worked: number; last_contacted_at: string | null } | null;
type Row = Record<string, unknown> & { relationship: Relationship };
// Vendors with no recorded deal history: the engine sends every count as 0.
function withoutHistory(url: string, vary?: (row: Row, n: number) => void) {
  const payload = directoryFixture(url);
  // The fixture is declared as a loose record; its list payload carries vendor rows.
  (payload.rows as Row[] | undefined)?.forEach((row, n) => {
    if (row.relationship)
      Object.assign(row.relationship, { deals_referred: 0, deals_worked: 0, won: 0, lost: 0, win_rate: null });
    vary?.(row, n);
  });
  return payload;
}

// Rows as uneven as real ones: long names and territories, and facts missing here and there.
function uneven(row: Row, n: number) {
  const territories = [
    "Gulf Coast (statewide; incl Escambia/Okaloosa/Walton)",
    "Demo North",
    null,
    "Big Bend/Panhandle",
  ];
  Object.assign(row, {
    name: n % 3 ? row.name : `${row.name} Equipment Finance Group`,
    territory: territories[n % 4],
    owner_label: n % 2 ? "Example Partner" : null,
    ...(n % 4 === 3 && { recorded_category: null }),
    ...(n % 5 === 1 && { recorded_category_label: "Supply / Equipment Rep" }),
    ...(n % 5 === 2 && { city: null, state: null }),
  });
  if (row.relationship && n % 3 === 1) row.relationship.last_contacted_at = null;
}

async function openVendors(
  t: TestContext,
  width: number,
  height: number,
  today?: "open",
  vary?: (row: Row, n: number) => void,
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.clock.install({ time: new Date("2026-10-01T18:00:00Z") });
  if (today) await page.addInitScript((state) => localStorage.setItem("doctorcre:today:/vendors", state), today);
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: withoutHistory(r.request().url(), vary) }));
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    const payload = request.params.name === "read-vendor-meetings" ? meetings : {};
    return route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: JSON.stringify(payload) }] } },
    });
  });
  await page.goto(`${server.url}/vendors?all=true`);
  await page.locator(".record-row").first().waitFor();
  await page.getByRole("button", { name: /^Quiet/ }).waitFor();
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
  [1200, 750],
  [1280, 679],
  [1280, 800],
  [1366, 768],
  [1440, 900],
] as const)
  test(`the Vendors list fills the first screen at ${width}x${height}`, async (t) => {
    const page = await openVendors(t, width, height);
    await page.screenshot({ path: `${shots}/vendors-${width}.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.listTop <= 112, `the list starts near the top, not at ${fit.listTop}px`);
    const rows = height >= 800 ? 12 : 10;
    assert.ok(fit.wholeRows >= rows, `at least ${rows} vendors show whole, not ${fit.wholeRows}`);
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

const rowLayout = (page: Page) =>
  page.evaluate(() => {
    const lefts = (selector: string) => [
      ...new Set(
        [...document.querySelectorAll(`.record-row ${selector}`)].map((node) =>
          Math.round(node.getBoundingClientRect().left),
        ),
      ),
    ];
    const brokenMidWord = [...document.querySelectorAll(".record-row .fact-value")].filter((value) => {
      const walker = document.createTreeWalker(value, NodeFilter.SHOW_TEXT);
      const chars: { char: string; top: number }[] = [];
      for (let node = walker.nextNode(); node; node = walker.nextNode())
        for (let i = 0; i < (node.textContent ?? "").length; i++) {
          const range = document.createRange();
          range.setStart(node, i);
          range.setEnd(node, i + 1);
          chars.push({ char: node.textContent?.[i] ?? "", top: range.getBoundingClientRect().top });
        }
      const wordEnds = (before = "", next = "") => /[\s/]/.test(before) || /\s/.test(next);
      return chars.some(
        (c, i) => i > 0 && c.top > (chars[i - 1]?.top ?? 0) + 1 && !wordEnds(chars[i - 1]?.char, c.char),
      );
    });
    return {
      columns: Object.fromEntries(
        [
          "[data-fact=Relationship]",
          "[data-fact=Category]",
          "[data-fact=Territory]",
          "[data-fact=Location]",
          ".contact-note",
        ].map((s) => [s, lefts(s)]),
      ),
      brokenMidWord: brokenMidWord.map((value) => value.textContent),
    };
  });

const cutFilters = (page: Page) =>
  page.evaluate(() =>
    [...document.querySelectorAll<HTMLSelectElement>("#filterForm select")]
      .filter((select) => select.checkVisibility())
      .filter((select) => {
        const shown = select.getBoundingClientRect().width;
        select.style.width = "max-content";
        const needed = select.getBoundingClientRect().width;
        select.style.width = "";
        return shown + 0.5 < needed;
      })
      .map((select) => select.selectedOptions[0]?.text),
  );

for (const [width, height, today] of [
  [1200, 750, undefined],
  [1200, 750, "open"],
  [1280, 800, undefined],
  [1280, 800, "open"],
  [1440, 900, undefined],
  [1440, 900, "open"],
] as const)
  test(`vendor facts line up and read whole at ${width}x${height}${today ? " beside Today" : ""}`, async (t) => {
    const page = await openVendors(t, width, height, today, uneven);
    await page.screenshot({ path: `${shots}/uneven-${width}${today ? "-today" : ""}.png` });
    const layout = await rowLayout(page);
    for (const [fact, lefts] of Object.entries(layout.columns))
      assert.equal(lefts.length, 1, `${fact} starts at one x on every row, not ${lefts.join(", ")}`);
    const [relationship = 0, category = 0, territory = 0, location = 0] = Object.values(layout.columns).map(
      ([left]) => left ?? 0,
    );
    assert.ok(
      relationship < category && category < territory && territory < location,
      `facts sit side by side: ${JSON.stringify(layout.columns)}`,
    );
    assert.deepEqual(layout.brokenMidWord, [], "facts wrap between words");
    assert.deepEqual(await cutFilters(page), [], "every filter shows its whole choice");
    assert.ok((await firstScreen(page)).listTop <= (today ? 160 : 112), "the toolbar stays compact");
  });

test("the vendor toolbar has no dropdowns, Reset or refresh", async (t) => {
  const page = await openVendors(t, 1200, 750);
  const shown = await page.evaluate(() =>
    ["#resetFilters", "#applyFilters", "#refreshList"].filter((selector) =>
      document.querySelector(selector)?.checkVisibility(),
    ),
  );
  assert.deepEqual(shown, []);
});

test("vendor rows take one line each under one header row that names the columns", async (t) => {
  const page = await openVendors(t, 1280, 640);
  await page.screenshot({ path: `${shots}/vendors-1280x640.png` });
  assert.ok((await firstScreen(page)).wholeRows >= 11, "at least 11 vendors show whole at 1280x640");
  const columns = await page.evaluate(() => {
    const left = (node: Element | null | undefined) => Math.round(node?.getBoundingClientRect().left ?? Number.NaN);
    const row = document.querySelector(".record-row");
    return [...document.querySelectorAll(".list-head :is(.row-head, [data-fact], .contact-note, .row-owner)")].map(
      (label) => {
        const fact = label.getAttribute("data-fact");
        const value = fact
          ? row?.querySelector(`[data-fact="${fact}"] .fact-value`)
          : label.classList.contains("row-head")
            ? row?.querySelector(".row-head")
            : row?.querySelector(`.${label.className}`);
        return { label: label.textContent, header: left(label), value: left(value) };
      },
    );
  });
  assert.deepEqual(
    columns.map(({ label }) => label),
    ["Name", "Relationship", "Category", "Territory", "Location", "Last contacted", "Owner"],
  );
  for (const { label, header, value } of columns) assert.equal(value, header, `${label} values sit under their label`);
});

test("every vendor fact reads on one line at 1280x640 with the card open", async (t) => {
  const page = await openVendors(t, 1280, 640, undefined, uneven);
  await page.locator(".record-row .row-head").first().click();
  await page.locator("body[data-card-open]").waitFor();
  const wrapped = await page.evaluate(() =>
    [...document.querySelectorAll(".record-row .fact-value")]
      .filter((value) => {
        const range = document.createRange();
        range.selectNodeContents(value);
        return new Set([...range.getClientRects()].map((rect) => Math.round(rect.top))).size > 1;
      })
      .map((value) => value.textContent),
  );
  assert.deepEqual(wrapped, [], "no fact wraps with the card open");
});

// A 1280 window with a mouse loses 15px to its scrollbar, which tipped the table into stacked rows; the headless browser draws none, so those two are 1265 wide.
for (const [name, width, height] of [
  ["1280x599 with a scrollbar", 1265, 599],
  ["1280x640 with a scrollbar", 1265, 640],
  ["1280x640", 1280, 640],
  ["1440x900", 1440, 900],
  ["1024x700", 1024, 700],
] as const)
  test(`the Vendors table keeps its columns with the card open at ${name}`, async (t) => {
    const page = await openVendors(t, width, height);
    await page.locator(".record-row .row-head").first().click();
    await page.locator("body[data-card-open]").waitFor();
    await page.screenshot({ path: `${shots}/vendors-card-${width}x${height}.png` });
    const table = await page.evaluate(() => ({
      header: document.querySelector(".list-head")?.checkVisibility() ?? false,
      rowHeights: [...document.querySelectorAll(".record-row")].map((row) =>
        Math.round(row.getBoundingClientRect().height),
      ),
      sideways: document.documentElement.scrollWidth > innerWidth,
    }));
    assert.equal(table.header, true, "the header row that names the columns shows");
    assert.ok(
      Math.max(...table.rowHeights) <= 52,
      `every vendor takes one line, not ${Math.max(...table.rowHeights)}px`,
    );
    assert.equal(table.sideways, false, "nothing scrolls sideways");
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
  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.locator(".directory-tile[href]").first().waitFor();
});
