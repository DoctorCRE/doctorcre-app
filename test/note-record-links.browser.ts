import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test, { after, before, type TestContext } from "node:test";
import type { Locator } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";
import { detail as leadDetail } from "./leads-workspace-fixture.mjs";

const root = new URL("../", import.meta.url);
const evidence = new URL("out/test-artifacts/note-record-links/", root).pathname;
const url = "/relationships?node=party:00000000-0000-4000-8000-000000000091";
const recordLinks = [{ text: "Demo Dental", url }];
const note = "Called Demo Dental about the lease. <b>Not markup</b>.";
let server: Awaited<ReturnType<typeof ownedFixtureServer>> | undefined;
before(async () => {
  await mkdir(evidence, { recursive: true });
  server = await ownedFixtureServer();
});
after(() => server?.close());

async function newPage(t: TestContext, width: number) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height: width === 390 ? 844 : 1000 } });
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.clock.install({ time: new Date("2026-10-04T17:00:00Z") });
  return { page, errors };
}

async function assertLinked(region: Locator) {
  assert.equal(await region.getByRole("link", { name: "Demo Dental", exact: true }).getAttribute("href"), url);
  assert.match((await region.textContent()) ?? "", /<b>Not markup<\/b>/);
}

for (const width of [1440, 390])
  test(`a named record in a deal note opens that record at ${width}px`, async (t) => {
    const { page, errors } = await newPage(t, width);
    const seed = JSON.parse(await readFile(new URL("data/board-seed.json", root), "utf8"));
    seed.threads.d14 = [
      {
        id: "demo-linked",
        kind: "note",
        actor: "joe",
        text: note,
        created_at: "2026-10-02T17:45:00Z",
        recorded_at: "2026-10-02T17:45:00Z",
      },
    ];
    await page.route("https://**", (r) => r.abort());
    await page.route("**/data/board-seed.json", (r) => r.fulfill({ json: seed }));
    await page.route("**/{api/**,app-release}", (r) => r.fulfill({ json: {} }));
    await page.goto(`${server?.origin}/deals?deal=d14`);
    await page.waitForSelector("#detailPhase");
    await page.evaluate(`import("/js/pipeline.js").then(({ state }) => {
      const read = state.client.getDeal;
      state.client.getDeal = async (...args) => ({ ...(await read(...args)), record_links: ${JSON.stringify(recordLinks)} });
    })`);
    await page.getByRole("button", { name: "Refresh deal" }).first().click();
    await page.locator(".updates-history > summary").click();
    await assertLinked(page.locator('.deal-note[data-id="demo-linked"]'));
    await page.getByRole("tab", { name: "Timeline", exact: true }).click();
    await assertLinked(page.locator(".workspace-events li", { hasText: "Called Demo Dental" }));
    await page.getByRole("tab", { name: "Correspondence & notes" }).click();
    const notes = page.getByRole("region", { name: "Deal notes" });
    await assertLinked(notes);
    await notes.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}deal-note-${width}.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
  });

for (const width of [1440, 390])
  test(`a named record in a client note opens that record at ${width}px`, async (t) => {
    const { page, errors } = await newPage(t, width);
    await page.route("https://**", (r) => r.abort());
    await page.route("**/{api/system-work/session,auth/session}", (r) =>
      r.fulfill({ json: { csrf_token: "synthetic-session", actor: { slug: "joe" } } }),
    );
    const { promise: activityAnswered, resolve: answerActivity } = Promise.withResolvers<void>();
    await page.route("**/mcp", async (r) => {
      await activityAnswered;
      return r.fulfill({
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: { content: [{ type: "text", text: JSON.stringify({ state: "not_found", candidates: [] }) }] },
        },
      });
    });
    await page.route("**/api/v1/business/**", (route) => {
      const json = directoryFixture(route.request().url());
      if (typeof json.record === "object" && json.record)
        Object.assign(json.record, { notes: note, record_links: recordLinks });
      return route.fulfill({ json });
    });
    await page.goto(`${server?.origin}/clients?mode=live`);
    await page.locator(".record-row").first().click();
    const section = page.getByRole("dialog", { name: /Demo Practice 01/ }).locator(".client-note");
    await assertLinked(section);
    await section.locator("p").selectText();
    answerActivity();
    await page.locator("#recordActivity .activity-note:not([data-state=loading])").waitFor();
    assert.match(await page.evaluate(() => String(getSelection())), /Called Demo Dental/, "Recent activity arriving keeps the note");
    await section.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${evidence}client-note-${width}.png`, animations: "disabled" });
    assert.deepEqual(errors, []);
  });

test("a named record in a lead plan opens that record", async (t) => {
  const { page, errors } = await newPage(t, 1440);
  await routeLeads(page, {
    getDetail: (row) => ({
      ...leadDetail(row),
      notes: `${note}\n\nAsked Demo Dental for a referral.`,
      record_links: recordLinks,
    }),
  });
  await page.goto("http://localhost/leads");
  await page.locator(".lead-card").first().click();
  await page.locator("#detailStage").waitFor();
  const plans = page.locator("#detailBody .detail-panel", {
    has: page.getByRole("heading", { name: "Plans", exact: true }),
  });
  await assertLinked(plans);
  await plans.getByText("More about these plans").click();
  const more = plans.locator(".plan-details").getByRole("link", { name: "Demo Dental", exact: true });
  assert.equal(await more.getAttribute("href"), url);
  assert.deepEqual(errors, []);
});
