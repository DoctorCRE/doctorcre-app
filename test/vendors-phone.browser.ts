import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import type { Page, Route } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

// The fixture is declared as a loose record; its list and summary answers carry these parts.
const fixture = (url: string) => directoryFixture(url) as Payload;
type Payload = Record<string, unknown> & {
  rows?: (Record<string, unknown> & { relationship?: Record<string, unknown> })[];
  facets?: { categories: { slug: string; label: string }[] };
  categories?: { slug: string; label: string }[];
};

async function openVendors(
  t: TestContext,
  width: number,
  height: number,
  { path = "/vendors?category=banker", answer = fixture, hold = false } = {},
) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  const held: Route[] = [];
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) =>
    hold && !r.request().url().includes("/summary") ? held.push(r) : r.fulfill({ json: answer(r.request().url()) }),
  );
  await page.route("**/mcp", (r) =>
    r.fulfill({
      json: { jsonrpc: "2.0", id: r.request().postDataJSON()?.id, result: { content: [{ type: "text", text: "{}" }] } },
    }),
  );
  await page.goto(`${server.url}${path}`);
  const release = () => Promise.all(held.splice(0).map((r) => r.fulfill({ json: answer(r.request().url()) })));
  return { page, release };
}

const lines = (page: Page) =>
  page.locator(".record-row").evaluateAll((rows) =>
    rows.map((row) => {
      const top = (selector: string) => {
        const box = row.querySelector(selector)?.getBoundingClientRect();
        return box && box.width > 0 ? Math.round(box.top + box.height / 2) : null;
      };
      return {
        name: top(".row-name"),
        relationship: top('[data-fact="Relationship"] .fact-value'),
        territory: top('[data-fact="Territory"] .fact-value'),
        contact: top(".contact-note"),
        hidden: top('[data-fact="Location"]') ?? top(".row-foot"),
      };
    }),
  );

test("on a phone each vendor is two lines: name and relationship, then territory and last contact", async (t) => {
  const { page } = await openVendors(t, 390, 844);
  await page.locator(".record-row").first().waitFor();
  const rows = await lines(page);
  for (const row of rows) {
    assert.equal(row.hidden, null, "Location and Owner stay on the computer table");
    assert.ok(
      row.name && row.relationship && Math.abs(row.name - row.relationship) < 6,
      "relationship beside the name",
    );
    assert.ok(
      row.territory && row.contact && Math.abs(row.territory - row.contact) < 6,
      "last contact beside territory",
    );
    assert.ok(row.territory > row.name, "territory under the name");
  }
  const clipped = await page
    .locator(".record-row .row-name")
    .evaluateAll((names) => names.filter((name) => name.scrollWidth > name.clientWidth).length);
  assert.equal(clipped, 0, "short names show whole beside a Want to meet tag");
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  const title = page.locator(".app-layout-tabs .summary-place");
  assert.equal(await title.textContent(), "Banking", "the category's name is the phone's title");
  assert.ok(await title.isVisible());
});

test("a vendor never contacted says No contact yet with no day count", async (t) => {
  const answer = (url: string) => {
    const payload = fixture(url);
    for (const row of payload.rows ?? []) if (row.quiet && row.relationship) row.relationship.last_contacted_at = null;
    return payload;
  };
  const { page } = await openVendors(t, 1440, 900, { answer });
  await page.locator(".record-row").first().waitFor();
  const quiet = await page.locator(".record-row .contact-note.quiet").allTextContents();
  assert.ok(quiet.length > 0, "the category holds quiet vendors");
  for (const text of quiet) assert.equal(text, "Last contacted No contact yet");
});

test("while a category loads it is named, never by its slug", async (t) => {
  const answer = (url: string) => {
    const payload = fixture(url);
    const rename = (list?: { slug: string; label: string }[]) =>
      list?.forEach((c) => {
        if (c.slug === "banker") c.label = "CPA / Financial";
      });
    rename(payload.facets?.categories);
    rename(payload.categories);
    return payload;
  };
  const { page, release } = await openVendors(t, 1440, 900, { path: "/vendors?category=banker", answer, hold: true });
  const search = page.getByRole("searchbox", { name: "Search" });
  await page.locator(".record-skeleton").first().waitFor();
  const shown = async () =>
    `${await search.getAttribute("placeholder")} ${await page.locator("#resultSummary").textContent()}`;
  assert.doesNotMatch(await shown(), /banker/, "a direct link never shows the slug");
  await release();
  await page.locator(".record-row").first().waitFor();
  assert.equal(await search.getAttribute("placeholder"), "Find in CPA / Financial");

  await page.getByRole("button", { name: "Categories", exact: true }).click();
  await page.locator("a.directory-tile", { hasText: "CPA / Financial" }).click();
  await page.locator(".record-skeleton").first().waitFor();
  assert.equal(await page.locator(".summary-place").textContent(), "CPA / Financial", "a tile's name, while it loads");
  assert.equal(await search.getAttribute("placeholder"), "Find in CPA / Financial");
});

test("the search hint shows whole for a long category name", async (t) => {
  const label = "Practice Management Consultant";
  const answer = (url: string) => {
    const payload = fixture(url);
    for (const c of payload.facets?.categories ?? []) c.label = label;
    return payload;
  };
  const { page } = await openVendors(t, 1280, 640, { answer });
  await page.locator(".record-row").first().waitFor();
  const fit = await page.getByRole("searchbox", { name: "Search" }).evaluate((input: HTMLInputElement) => {
    const style = getComputedStyle(input);
    const context = document.createElement("canvas").getContext("2d");
    if (!context) return null;
    context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    const room = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
    return { hint: context.measureText(input.placeholder).width, room, placeholder: input.placeholder };
  });
  assert.equal(fit?.placeholder, `Find in ${label}`);
  assert.ok(fit && fit.hint <= fit.room, `the hint (${fit?.hint}px) fits its box (${fit?.room}px)`);
});

test("a vendor's card follows the screen spec's order and ends with Where", async (t) => {
  const { page } = await openVendors(t, 1440, 900);
  await page.locator(".record-row").nth(1).click();
  await page.locator("#recordActivity").waitFor();
  const headings = await page
    .locator("#recordPanel .record-panel-body > section > h3, #recordPanel .detail-columns h3")
    .allTextContents();
  const order = ["Contacts & offices", "Conversations", "Partnership", "Where"].map((title) => headings.indexOf(title));
  assert.ok(
    order.every((at) => at >= 0),
    `each section is drawn: ${headings.join(", ")}`,
  );
  assert.deepEqual(
    order,
    [...order].sort((a, b) => a - b),
    `in the spec's order: ${headings.join(", ")}`,
  );
  assert.equal(headings.at(-2), "Where", "Where is the last vendor section before Recent activity");
});
