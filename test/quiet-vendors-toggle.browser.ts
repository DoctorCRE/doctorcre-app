import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/quiet-vendors-toggle";
await mkdir(shots, { recursive: true });

type Row = { id: string; name: string };
// The engine answers quiet=true with only the quiet vendors; here every third made-up vendor is quiet.
function answer(url: string) {
  const asked = new URL(url);
  const quiet = asked.searchParams.get("quiet") === "true";
  asked.searchParams.delete("quiet");
  const payload = directoryFixture(asked.href);
  if (!quiet || !Array.isArray(payload.rows)) return payload;
  // The fixture is declared as a loose record; its list payload carries vendor rows.
  const rows = (payload.rows as Row[]).filter((_, n) => n % 3 === 0);
  // Its list payload always echoes the query object it answered.
  const query = payload.query as object;
  return { ...payload, query: { ...query, quiet: true }, rows, total: rows.length, page_count: 1 };
}

test("Quiet narrows the same list in place and a second press shows every vendor", async (t) => {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: answer(r.request().url()) }));
  await page.route("**/mcp", (r) => r.fulfill({ json: { jsonrpc: "2.0", id: 1, result: { content: [] } } }));
  await page.goto(`${server.url}/vendors?all=true`);
  const rows = page.locator(".record-row");
  await rows.first().waitFor();
  const all = await rows.count();

  const toggle = page.getByRole("button", { name: /^Quiet/ });
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await toggle.click();
  await page.waitForURL(/quiet=true/);
  const quiet = Math.ceil(all / 3);
  await page.waitForFunction((count) => document.querySelectorAll(".record-row").length === count, quiet);
  assert.equal(await toggle.getAttribute("aria-pressed"), "true");
  assert.equal(await page.getByRole("region", { name: "Quiet vendor follow-ups" }).count(), 0, "no separate section");
  await page.screenshot({ path: `${shots}/quiet-on-1440.png` });

  await toggle.click();
  await page.waitForURL((url) => !url.searchParams.has("quiet"));
  await page.waitForFunction((count) => document.querySelectorAll(".record-row").length === count, all);
  assert.equal(await toggle.getAttribute("aria-pressed"), "false");
  await page.screenshot({ path: `${shots}/quiet-off-1440.png` });

  const relationship = await rows.first().locator('[data-fact="Relationship"] .fact-value').textContent();
  await rows.first().click();
  await page.locator("#recordMeta .rel-word").waitFor();
  assert.equal(
    await page.locator("#recordMeta .rel-word").textContent(),
    relationship,
    "the drawer says the relationship the list says",
  );
  await page.screenshot({ path: `${shots}/drawer-1440.png` });
});
