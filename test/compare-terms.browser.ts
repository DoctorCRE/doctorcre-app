import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { Page } from "playwright";
import { buildArtifact } from "../scripts/artifact.mjs";
import { inspectPhoneAccessibility } from "../scripts/phone-accessibility.ts";
import { temporaryDirectory } from "../scripts/temp-directory.mjs";
import { chromium, componentDocument } from "./browser-harness.mjs";
import { ownedServer } from "./fixture-probe.ts";

const root = fileURLToPath(new URL("../", import.meta.url));
const loi = "00000000-0000-4000-8000-0000000000a1";
const signed = "00000000-0000-4000-8000-0000000000a2";
const openDeal = "00000000-0000-4000-8000-0000000000c9";
const property = { id: "00000000-0000-4000-8000-0000000000b1", name: null, address: "1 Example North Road" };
const row = (fields: Record<string, unknown>) => ({
  deal_id: "00000000-0000-4000-8000-0000000000c1",
  deal_name: "Example North Clinic",
  property,
  stage: "round",
  number: 1,
  recorded_on: "2026-03-02",
  term: "rent_per_sf_yr",
  value: 32.5,
  expense_structure: null,
  superseded: true,
  documents: [{ id: loi, name: "Example LOI.pdf" }],
  ...fields,
});
const recorded = {
  schema_version: "compare-terms.v1",
  market: "Example North",
  rows: [
    row({
      stage: "lease",
      number: 1,
      recorded_on: "2026-05-01",
      value: 31,
      expense_structure: "NNN",
      superseded: false,
      documents: [{ id: signed, name: "Example lease.pdf" }],
    }),
    row({ stage: "round", number: 2, recorded_on: "2026-04-01", value: 31, superseded: false, documents: [] }),
    row({}),
    row({ term: "ti_per_sf", value: 40 }),
    row({
      deal_id: "00000000-0000-4000-8000-0000000000c2",
      deal_name: "Example North Dental",
      property: {
        id: "00000000-0000-4000-8000-0000000000b2",
        name: "Example Dental Plaza",
        address: "2 Example North Road",
      },
      recorded_on: "2026-03-03",
      term: "free_rent_months",
      value: 3,
      superseded: false,
      documents: [],
    }),
  ],
};

async function mount(page: Page, server: string, theme: "light" | "dark") {
  await componentDocument(page, server, {
    html: `<!doctype html><html lang="en" data-theme="${theme}"><title>Compare terms fixture</title><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/system.css"><link rel="stylesheet" href="/css/pipeline.css"><body><main></main></body></html>`,
    dispose: (page) => page.evaluate(() => Reflect.get(window, "compareTest")?.panel.dispose()),
  });
  await page.evaluate(
    async ({ body, dealId }) => {
      const path = "/js/ui-compare-terms.generated.js";
      const { mountCompareTerms } = await import(path);
      const paths: string[] = [];
      const state = { paths, reply: { status: 200, body }, panel: { dispose() {} } };
      Reflect.set(window, "compareTest", state);
      state.panel = mountCompareTerms(document.querySelector("main"), {
        dealId,
        market: "Example North",
        markets: ["Example North", "Example South"],
        request: async (path: string) => {
          state.paths.push(path);
          const { status, body } = state.reply;
          return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
        },
      });
    },
    { body: recorded, dealId: openDeal },
  );
  await page.locator(".market-terms-table").waitFor();
}

const count = (page: Page) => page.locator("[data-market-results] > p > strong").last().textContent();

test("Compare terms reads the engine and filters recorded terms at both widths and themes", async (t) => {
  const artifact = temporaryDirectory("doctorcre-compare-terms-", t);
  await buildArtifact({ root, outDir: artifact, commit: "1".repeat(40) });
  const server = await ownedServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const shots = "out/test-artifacts/compare-terms";
  await mkdir(shots, { recursive: true });

  for (const width of [1280, 1440, 390])
    for (const theme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width, height: 900 }, colorScheme: theme });
      try {
        await mount(page, server.url, theme);
        assert.deepEqual(await page.evaluate(() => Reflect.get(window, "compareTest").paths), [
          `/api/engine/market-terms?market=Example+North&exclude_deal_id=${openDeal}`,
        ]);
        assert.equal(await page.getByLabel("Market").inputValue(), "Example North");
        await page.getByText("Compared with Example North · All recorded history", { exact: true }).waitFor();
        assert.equal(await count(page), "5 matching terms across 2 deals.");
        const first = page.locator(".market-terms-table tbody tr").first();
        assert.deepEqual(await first.locator("td").allTextContents(), [
          "Fri, May 1, 2026",
          "Example North Clinic",
          "1 Example North Road",
          "Signed lease, version 1",
          "Rent: $31.00/sf/yr",
          "NNN",
          "Example lease.pdf",
        ]);
        assert.equal(
          await first.getByRole("link", { name: "Example lease.pdf" }).getAttribute("href"),
          `/api/engine/documents/${signed}`,
        );
        const second = page.locator(".market-terms-table tbody tr").nth(1);
        assert.equal(await second.locator('[data-label="Source"]').textContent(), "No document filed");
        assert.equal(await second.locator('[data-label="Expense basis"]').textContent(), "Not recorded");
        assert.equal(
          await page.locator(".market-terms-table tbody tr").nth(2).locator('[data-label="Stage"]').textContent(),
          "Offer round 1 · superseded",
        );
        assert.equal(
          await page.locator('.market-terms-table [data-label="Term"]').last().textContent(),
          "Free rent: 3 months",
        );
        assert.equal(
          await page.locator('.market-terms-table [data-label="Property"]').last().textContent(),
          "Example Dental Plaza",
        );

        const inspected = await inspectPhoneAccessibility(page);
        assert.equal(inspected.overflow, false, `${width} ${theme}: no sideways scroll`);
        assert.deepEqual(inspected.small, [], `${width} ${theme}: every target is at least 44 by 44`);
        assert.deepEqual(inspected.covered, [], `${width} ${theme}: no target is covered`);
        assert.deepEqual(inspected.violations, [], `${width} ${theme}: no accessibility violations`);
        await page.screenshot({ path: `${shots}/${width}-${theme}.png`, fullPage: true });

        await page.getByRole("combobox", { name: "Term", exact: true }).selectOption({ label: "TI" });
        assert.equal(await count(page), "1 matching term across 1 deal.");
        await page.getByRole("combobox", { name: "Term", exact: true }).selectOption({ label: "All terms" });
        await page.getByRole("combobox", { name: "Recorded stage" }).selectOption({ label: "Signed lease" });
        assert.equal(await count(page), "1 matching term across 1 deal.");
        await page.getByRole("combobox", { name: "Recorded stage" }).selectOption({ label: "All recorded stages" });
        await page.getByRole("combobox", { name: "Expense basis" }).selectOption({ label: "Not recorded" });
        assert.equal(await count(page), "4 matching terms across 2 deals.");
        await page.getByRole("checkbox", { name: "Hide superseded terms" }).check();
        assert.equal(await count(page), "2 matching terms across 2 deals.");
        await page.getByRole("combobox", { name: "Expense basis" }).selectOption({ label: "All expense bases" });
        assert.equal(await count(page), "3 matching terms across 2 deals.");

        await page.getByLabel("Use type").fill("Medical office");
        await page.getByLabel("As of date (optional)").fill("2026-05-15");
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("Compared with Example North · Terms as of Fri, May 15, 2026", { exact: true }).waitFor();
        assert.equal(
          (await page.evaluate(() => Reflect.get(window, "compareTest").paths)).at(-1),
          `/api/engine/market-terms?market=Example+North&use_type=Medical+office&as_of=2026-05-15&exclude_deal_id=${openDeal}`,
        );

        await page.evaluate(() => {
          Reflect.get(window, "compareTest").reply = { status: 503, body: { error: "unhandled_verb_failure" } };
        });
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("Comparable terms are unavailable.").waitFor();
        await page.evaluate(() => {
          Reflect.get(window, "compareTest").reply = {
            status: 200,
            body: { schema_version: "compare-terms.v1", rows: [] },
          };
        });
        await page.getByRole("button", { name: "Retry" }).click();
        await page.getByText("Nothing matches the market, use type and date entered.", { exact: true }).waitFor();
        assert.equal(await page.getByRole("combobox").count(), 0, "no filters without terms");
        assert.equal(await page.getByRole("checkbox").count(), 0, "no superseded toggle without terms");
        assert.equal(await page.getByText(/matching terms? across/).count(), 0, "no count without terms");
        await page.screenshot({ path: `${shots}/${width}-${theme}-empty-filtered.png`, fullPage: true });

        await page.getByLabel("Use type").fill("");
        await page.getByLabel("As of date (optional)").fill("");
        await page.getByRole("button", { name: "Compare" }).click();
        await page
          .getByText("No offer rounds or signed leases are recorded on deals in this market yet.", { exact: true })
          .waitFor();
        await page.getByText("Compared with Example North · All recorded history", { exact: true }).waitFor();
        await page.screenshot({ path: `${shots}/${width}-${theme}-empty-market.png`, fullPage: true });

        await page.getByLabel("Market").fill("");
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("No offer rounds or signed leases are recorded yet.", { exact: true }).waitFor();
        await page.getByText("Compared with all markets · All recorded history", { exact: true }).waitFor();
        assert.equal(
          (await page.evaluate(() => Reflect.get(window, "compareTest").paths)).at(-1),
          `/api/engine/market-terms?exclude_deal_id=${openDeal}`,
        );
        await page.screenshot({ path: `${shots}/${width}-${theme}-empty-all.png`, fullPage: true });

        await page.getByLabel("Use type").fill("Medical office");
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("Nothing matches the use type entered.", { exact: true }).waitFor();

        await page.getByLabel("Market").fill("Example North");
        await page.getByLabel("Use type").fill("");
        await page.getByLabel("As of date (optional)").fill("2026-05-15");
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("Nothing matches the market and date entered.", { exact: true }).waitFor();

        await page.getByLabel("Market").fill(" example south ");
        await page.getByLabel("As of date (optional)").fill("");
        await page.getByRole("button", { name: "Compare" }).click();
        await page.getByText("Compared with Example South · All recorded history", { exact: true }).waitFor();
        assert.equal(
          (await page.evaluate(() => Reflect.get(window, "compareTest").paths)).at(-1),
          `/api/engine/market-terms?market=Example+South&exclude_deal_id=${openDeal}`,
        );
      } finally {
        await page.close();
      }
    }
});

test("Compare terms shows all terms when a saved choice is missing and says why a table is empty", async (t) => {
  const artifact = temporaryDirectory("doctorcre-compare-terms-", t);
  await buildArtifact({ root, outDir: artifact, commit: "1".repeat(40) });
  const server = await ownedServer({ env: { DOCTORCRE_FIXTURE_ROOT: `${artifact}/site` } });
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await mount(page, server.url, "light");
  const term = page.getByRole("combobox", { name: "Term", exact: true });
  const stage = page.getByRole("combobox", { name: "Recorded stage" });
  const basis = page.getByRole("combobox", { name: "Expense basis" });

  await term.selectOption({ label: "TI" });
  await stage.selectOption({ label: "Offer round" });
  await basis.selectOption({ label: "Not recorded" });
  assert.equal(await count(page), "1 matching term across 1 deal.");
  await stage.selectOption({ label: "Signed lease" });
  await page.getByText("No comparable terms match these filters.", { exact: true }).waitFor();
  assert.equal(await count(page), "0 matching terms across 0 deals.");
  await stage.selectOption({ label: "Offer round" });

  const lease = recorded.rows[0];
  await page.evaluate(
    (rows) => {
      Reflect.get(window, "compareTest").reply = { status: 200, body: { schema_version: "compare-terms.v1", rows } };
    },
    [lease, { ...lease, documents: [] }],
  );
  await page.getByRole("button", { name: "Compare" }).click();
  for (const notice of [
    "The selected term is not in these results. Showing all terms.",
    "The selected recorded stage is not in these results. Showing all recorded stages.",
    "The selected expense basis is not in these results. Showing all expense bases.",
  ])
    await page.getByText(notice, { exact: true }).waitFor();
  assert.deepEqual([await term.inputValue(), await stage.inputValue(), await basis.inputValue()], ["", "", ""]);
  assert.equal(await count(page), "2 matching terms across 1 deal.");
  assert.equal(await page.locator(".market-terms-table tbody tr").count(), 2, "two leases on one deal both show");
  await page.close();
});
