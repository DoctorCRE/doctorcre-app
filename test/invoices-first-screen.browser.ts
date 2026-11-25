import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { invoiceTrackerFixture } from "../js/invoice-tracker-fixture.js";
import { CHROMIUM_SAFETY_ARGS } from "../scripts/chromium-safety-args.mjs";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";

const today = "2026-10-02";
const daysAgo = (days: number) => new Date(Date.parse(today) - days * 86_400_000).toISOString().slice(0, 10);

// Enough unpaid invoices in every age range that the table must scroll inside itself.
// With partial amounts, one invoice in each age range has no recorded amount.
function longTracker(partial: boolean) {
  const tracker = invoiceTrackerFixture(today);
  const template = tracker.entries[0];
  assert.ok(template);
  for (let n = 1; n <= 24; n++) {
    const age = (n * 17) % 130;
    tracker.entries.push({
      ...template,
      deal_id: `synthetic-invoice-deal-${n}`,
      name: `Synthetic Practice ${n}`,
      owner: n % 3 ? "joe" : "dell",
      commission_id: `00000000-0000-4000-9000-${String(n).padStart(12, "0")}`,
      gross_amount: partial && n <= 8 ? null : String(1000 + n * 250),
      closed_on: daysAgo(age + 7),
      invoiced_on: daysAgo(age),
      commission_invoiced_on: daysAgo(age),
      due_on: daysAgo(age - 30),
    });
  }
  return tracker;
}

let assets: ReturnType<typeof appAssetSnapshot> | undefined;

async function openInvoices(width: number, height: number, { partial = false } = {}) {
  assets ??= appAssetSnapshot(undefined, fileURLToPath(new URL("../", import.meta.url)));
  const snapshot = await assets;
  const browser = await chromium.launch({ args: [...CHROMIUM_SAFETY_ARGS] });
  const page = await browser.newPage({ viewport: { width, height }, timezoneId: "UTC", reducedMotion: "reduce" });
  await page.clock.install({ time: new Date(`${today}T17:00:00Z`) });
  await page.addInitScript(() => localStorage.setItem("doctorcre:today:/invoices", "open"));
  const tracker = longTracker(partial);
  const answers: Record<string, unknown> = {
    "read-invoice-tracker": tracker,
    "deal-room-board": { actor: "joe", deals: [] },
    "lead-board": { leads: [] },
    "read-home-agenda": { schema_version: "home-agenda.v1", actor: "joe", deals: [] },
  };
  const env = {
    APP_ENV: "fixture",
    GIT_SHA: "",
    CARR: {
      fetch: async (request: Request) => {
        if (new URL(request.url).pathname === "/mcp") {
          const { name } = (await request.json()).params;
          const text = JSON.stringify(answers[name] ?? { ok: true });
          return Response.json({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text }] } });
        }
        return Response.json({ actor: { slug: "joe" }, csrf_token: "synthetic-session", items: [], counts: {} });
      },
    },
    ASSETS: {
      fetch: async (request: Request) => {
        const asset = snapshot.get(new URL(request.url).pathname);
        return asset
          ? new Response(new Uint8Array(asset.body), { headers: { "content-type": asset.contentType } })
          : new Response(null, { status: 404 });
      },
    },
  };
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (new URL(request.url()).origin !== "http://localhost") return route.abort();
    const body = request.postData();
    const response = await worker.fetch(
      new Request(request.url(), { method: request.method(), headers: request.headers(), ...(body ? { body } : {}) }),
      env,
    );
    return route.fulfill({
      status: response.status,
      headers: Object.fromEntries(response.headers),
      body: Buffer.from(await response.arrayBuffer()),
    });
  });
  await page.goto("http://localhost/invoices?mode=live");
  await page.locator("[data-invoice]").first().waitFor();
  return { browser, page };
}

async function capture(page: Page, name: string) {
  const directory = process.env.INVOICES_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

const measure = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
    const main = document.getElementById("appMainSlot") ?? document.documentElement;
    const table = document.querySelector(".invoice-table");
    return {
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      mainScroll: main.scrollHeight - main.clientHeight,
      strip: box("#invoiceSummary"),
      ledger: box(".invoice-ledger"),
      head: box(".invoice-column-head"),
      firstRow: box("[data-invoice]"),
      tableOverflow: table ? table.scrollHeight - table.clientHeight : 0,
      updated: document.getElementById("invoiceUpdated")?.textContent ?? "",
      today: document.querySelector(".app-layout")?.getAttribute("data-today"),
      parts: [...document.querySelectorAll("#invoiceSummary :is(.invoice-totals, .invoice-chip)")].map((node) => {
        const { top, bottom } = node.getBoundingClientRect();
        return { top, bottom };
      }),
      divider: (({ content, visibility }) => (content === "none" ? "none" : visibility))(
        getComputedStyle(document.querySelector(".invoice-aging") ?? document.body, "::before"),
      ),
      tracks: [...document.querySelectorAll<HTMLElement>(".invoice-age")].map((chip) => {
        const outer = chip.getBoundingClientRect();
        const track = chip.querySelector(".age-track")?.getBoundingClientRect() ?? new DOMRect();
        return { chipLeft: outer.left, chipRight: outer.right, left: track.left, right: track.right };
      }),
    };
  });

const oneRow = (parts: { top: number; bottom: number }[]) =>
  Math.max(...parts.map((part) => part.top)) < Math.min(...parts.map((part) => part.bottom));

for (const [width, height, partial] of [
  [1280, 800, false],
  [1280, 800, true],
  [1440, 900, false],
  [1440, 900, true],
] as const)
  test(`Invoices table fills the first screen without a page scroll at ${width}x${height}${partial ? " with unrecorded amounts" : ""}`, async (t) => {
    const { browser, page } = await openInvoices(width, height, { partial });
    t.after(() => browser.close());
    await capture(page, `invoices-${width}x${height}${partial ? "-partial" : ""}`);
    const layout = await measure(page);
    const detail = JSON.stringify(layout);
    assert.equal(layout.today, "open", "Today is open beside the table");
    assert.ok(oneRow(layout.parts), `the totals and every age chip share one row: ${detail}`);
    assert.equal(layout.divider, "visible", `a divider separates the totals from the age chips: ${detail}`);
    assert.ok(
      layout.tracks.length === 4 &&
        layout.tracks.every(
          (track) => track.left > track.chipLeft && track.right < track.chipRight && track.right > track.chipRight - 16,
        ),
      `each age bar spans its chip and ends inside it: ${detail}`,
    );
    assert.equal(layout.pageScroll, 0, detail);
    assert.ok(layout.mainScroll <= 0, `the main region does not scroll: ${detail}`);
    // An unpriced count adds one short line under the amount.
    const stripLimit = partial ? 84 : 64;
    assert.ok(
      layout.strip.height > 0 && layout.strip.height <= stripLimit,
      `the summary is one short strip: ${detail}`,
    );
    assert.ok(layout.strip.bottom <= layout.ledger.top, `the strip sits above the table: ${detail}`);
    assert.ok(layout.ledger.top <= 200, `the table starts near the top: ${detail}`);
    assert.ok(
      layout.ledger.bottom <= height && layout.ledger.height >= height / 2,
      `the table fills the height: ${detail}`,
    );
    assert.ok(layout.tableOverflow > 0, `the rows scroll inside the table: ${detail}`);
    assert.match(layout.updated, /^Updated \d{1,2}:\d{2}\s?[AP]M$/, "the time has no time-zone label");

    await page
      .locator(".invoice-table")
      .evaluate((node) => node.scrollTo({ top: node.scrollHeight, behavior: "instant" }));
    const scrolled = await measure(page);
    assert.equal(scrolled.head.top, layout.head.top, "the column header stays in place while rows scroll");
    assert.ok(scrolled.firstRow.top < layout.head.top, "the rows moved under the header");
    assert.equal(scrolled.pageScroll, 0, "scrolling the rows does not scroll the page");
  });

test("Invoices summary strip wraps without a stray divider at 1024x768 with Today open", async (t) => {
  const { browser, page } = await openInvoices(1024, 768, { partial: true });
  t.after(() => browser.close());
  await capture(page, "invoices-1024x768-partial");
  const layout = await measure(page);
  const detail = JSON.stringify(layout);
  assert.equal(layout.today, "open", "Today is open beside the table");
  assert.equal(oneRow(layout.parts), false, `the age chips wrap under the totals: ${detail}`);
  assert.equal(layout.divider, "hidden", `no divider sits at the start of the wrapped row: ${detail}`);
});

for (const partial of [false, true])
  test(`Invoices summary strip holds still at every width near its wrap point${partial ? " with unrecorded amounts" : ""}`, async (t) => {
    const { browser, page } = await openInvoices(1240, 800, { partial });
    t.after(() => browser.close());
    const unsteady: string[] = [];
    for (let width = 1240; width <= 1270; width++) {
      await page.setViewportSize({ width, height: 800 });
      const strip = await page.evaluate(async () => {
        const frame = () => new Promise((resolve) => requestAnimationFrame(resolve));
        for (let i = 0; i < 3; i++) await frame();
        const summary = document.getElementById("invoiceSummary");
        const states: boolean[] = [];
        for (let i = 0; i < 8; i++) {
          states.push(summary?.hasAttribute("data-wrapped") ?? false);
          await frame();
        }
        const aging = document.querySelector(".invoice-aging")?.getBoundingClientRect();
        const totals = document.getElementById("invoiceTotals")?.getBoundingClientRect();
        return { states, wrapped: (aging?.top ?? 0) >= (totals?.bottom ?? 0) };
      });
      if (strip.states.some((state) => state !== strip.wrapped)) unsteady.push(`${width}: ${JSON.stringify(strip)}`);
    }
    assert.deepEqual(unsteady, [], "the strip keeps one wrapped state that matches its layout");
  });

test("Invoices age chips in the summary strip filter the table and mark the active chip", async (t) => {
  const { browser, page } = await openInvoices(1440, 900);
  t.after(() => browser.close());
  const strip = page.locator("#invoiceSummary");
  const chip = strip.locator('#invoiceAging [data-age="1"]');
  const allAges = strip.locator("#allAges");
  const look = (locator: typeof chip) =>
    locator.evaluate((node) => {
      const style = getComputedStyle(node);
      return `${style.backgroundColor}|${style.borderTopColor}|${style.boxShadow}`;
    });
  const inactive = await look(chip);
  await chip.click();
  await capture(page, "invoices-1440x900-age-31-60");
  assert.equal(await chip.getAttribute("aria-pressed"), "true");
  assert.equal(await allAges.getAttribute("aria-pressed"), "false");
  assert.notEqual(await look(chip), inactive, "the active chip looks different from an inactive one");
  const ages = await page.locator("[data-invoice]").evaluateAll((nodes) => nodes.map((node) => node.dataset.age));
  assert.ok(ages.length > 0 && ages.every((age) => age === "1"), `only 31 to 60 day invoices show: ${ages}`);
  assert.equal(await page.locator("#invoiceFiltered").textContent(), "31–60 days");
  assert.match((await page.locator("#invoiceCount").textContent()) ?? "", new RegExp(`Invoices · ${ages.length}$`));
  await allAges.click();
  assert.equal(await allAges.getAttribute("aria-pressed"), "true");
  assert.ok((await page.locator("[data-invoice]").count()) > ages.length, "All ages restores every unpaid invoice");
});

test("Invoices summary strip wraps cleanly at 390x844", async (t) => {
  const { browser, page } = await openInvoices(390, 844);
  t.after(() => browser.close());
  await capture(page, "invoices-390x844");
  const layout = await page.evaluate(() => {
    const parts = [
      ...document.querySelectorAll<HTMLElement>("#invoiceSummary :is(.invoice-total, #allAges, .invoice-age)"),
    ]
      .map((node) => node.getBoundingClientRect())
      .map(({ left, right, top, bottom }) => ({ left, right, top, bottom }));
    return {
      overflow: document.documentElement.scrollWidth > innerWidth,
      parts,
      firstRow: document.querySelector("[data-invoice]")?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
    };
  });
  const detail = JSON.stringify(layout);
  assert.equal(layout.overflow, false, detail);
  assert.equal(layout.parts.length, 8, `three totals, All ages and four age chips: ${detail}`);
  assert.ok(
    layout.parts.every((part) => part.left >= 0 && part.right <= 390),
    `every part of the strip fits the width: ${detail}`,
  );
  const overlaps = layout.parts.some((a, i) =>
    layout.parts
      .slice(i + 1)
      .some((b) => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1),
  );
  assert.equal(overlaps, false, `no part of the strip covers another: ${detail}`);
  assert.ok(layout.firstRow < 844, `an invoice shows on the first screen: ${detail}`);
});
