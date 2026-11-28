import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page, Route } from "playwright";
import type { VendorRelationships } from "../src/ui/vendor-relationships.tsx";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/vendor-relationships";
await mkdir(shots, { recursive: true });
const vendorId = "00000000-0000-4000-8000-000000000001";
const vendorName = "Demo Partner 01";
const client = (n: number) => ({ party_id: `c${n}`, name: `Example Client ${n}` });
const relationships: VendorRelationships = {
  relationship_partner: "joe",
  sent_us: [
    {
      introduction_id: "s1",
      client: client(1),
      deal: { id: "d1", name: "Example first office", open: false },
      introduced_on: "2026-03-02",
    },
    { introduction_id: "s2", client: client(2), deal: null, introduced_on: null },
  ],
  we_sent_them: [
    {
      introduction_id: "w1",
      client: client(3),
      deal: { id: "d3", name: "Example second office", open: true },
      introduced_on: "2026-11-10",
      introduced_by: "joe",
      chosen: true,
    },
    {
      introduction_id: "w2",
      client: client(4),
      deal: { id: "d4", name: "Example new office", open: true },
      introduced_on: "2026-10-02",
      introduced_by: null,
      chosen: false,
    },
  ],
  worked_with: [{ id: "d5", name: "Example renewal", open: true, client: client(5) }],
  knows: [{ party_id: "k1", name: "Example Pelican Bank" }],
  can_introduce: [{ party_id: "o1", name: "Example Oral Surgeon" }],
  counts: { sent_us: 2, we_sent_them: 2, chosen: 1, knows: 1 },
};
const nothing: VendorRelationships = {
  relationship_partner: "dell",
  sent_us: [],
  we_sent_them: [],
  worked_with: [],
  knows: [],
  can_introduce: [],
  counts: { sent_us: 0, we_sent_them: 0, chosen: 0, knows: 0 },
};

type Answer = (route: Route) => Promise<void>;
const answer =
  (body: VendorRelationships): Answer =>
  (route) =>
    route.fulfill({ json: body });

async function openCard(t: TestContext, read: Answer, { width = 1440, height = 900, scheme = "dark" } = {}) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
  }, scheme);
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }));
  let reads = 0;
  await page.route("**/api/engine/vendors/*/relationships", (route) => {
    reads++;
    return read(route);
  });
  await page.goto(`${server.url}/vendors?all=true&record=${vendorId}&mode=live`);
  const panel = page.locator("#recordPanel");
  const section = panel.locator(".vendor-relationships-section");
  await section.waitFor({ state: "attached" });
  return { page, panel, section, reads: () => reads };
}

const settle = (page: Page) =>
  page.evaluate(() => new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame))));

test("a vendor's card counts and draws who they sent us, who we sent them and who they know", async (t) => {
  const { page, section, reads } = await openCard(t, answer(relationships));
  await section.locator(".vendor-diagram").waitFor();
  assert.equal(await section.locator("h3").textContent(), "Relationships");
  assert.equal(await section.locator(".vendor-diagram-counts").textContent(), "Sent us 2We sent them 2Chosen 1Knows 1");
  const groups = await section
    .locator(".deal-diagram-junction > span")
    .evaluateAll((spans) => spans.map((span) => span.textContent));
  assert.deepEqual(groups, [
    "Sent us 2",
    "We sent them 2",
    "On deals, source not recorded 1",
    "Knows 1",
    "Can introduce us to 1",
  ]);
  const boxes = await section
    .locator(".deal-diagram-box")
    .evaluateAll((nodes) => nodes.map((node) => [node.getAttribute("data-tone"), node.textContent]));
  assert.deepEqual(boxes, [
    ["client", `${vendorName}Vendor`],
    ["person", "JJoeRelationship partner"],
    ["chosen", "Example Client 1Example first office · Deal closed"],
    ["introduced", "Example Client 2No deal yet"],
    ["chosen", "Example Client 3Example second office · Chosen"],
    ["introduced", "Example Client 4Example new office · Introduced"],
    ["onDeal", "Example Client 5Example renewal · On the deal"],
    ["person", "Example Pelican Bank"],
    ["offered", "Example Oral SurgeonOffered"],
  ]);
  await settle(page);
  assert.equal(reads(), 1, "one read per card open");
});

test("opening relationships shows sides in place of the table, with who introduced each and when", async (t) => {
  const { page, section } = await openCard(t, answer(relationships));
  const opener = section.getByRole("button", { name: `Open ${vendorName}'s relationships large` });
  await opener.click();
  const opened = page.locator(".client-deal-opened .vendor-diagram[data-size='sides']");
  await opened.waitFor();
  assert.equal(await page.locator("#listRegion").isVisible(), false, "the table steps aside");
  const side = (name: string) =>
    opened.locator(`[data-side='${name}'] .deal-diagram-text > b`).evaluateAll((n) => n.map((b) => b.textContent));
  assert.equal(
    await opened.locator("[data-tone='client'] .rel-shape").getAttribute("data-relationship"),
    await page.locator("#recordPanel [data-relationship]").first().getAttribute("data-relationship"),
    "the vendor's box carries the relationship its card shows",
  );
  await page.screenshot({ path: `${shots}/sides-1440-dark.png` });
  assert.deepEqual(await side("left"), ["Example Client 1", "Example Client 2"]);
  assert.deepEqual(await side("right"), ["Example Client 3", "Example Client 4", "Example Client 5"]);
  assert.deepEqual(await opened.locator(".deal-diagram-date").allTextContents(), [
    "Sent Mar 2, 2026",
    "Joe introduced Nov 10, 2026",
    "Introduced by: not recorded",
  ]);
  const links = await opened
    .locator(".vendor-diagram-links path")
    .evaluateAll((paths) => paths.map((path) => path.getAttribute("data-line")));
  assert.deepEqual(links, ["chosen", "plain", "chosen", "plain", "dashed"], "a line to every box beside the vendor");
  const [partner, vendor] = await opened
    .locator(".vendor-diagram-middle .deal-diagram-box")
    .evaluateAll((nodes) => nodes.slice(0, 2).map((node) => node.getBoundingClientRect().top));
  assert.ok((partner ?? 0) < (vendor ?? 0), "the partner sits above the vendor");
  await page.getByRole("button", { name: "Back to the table" }).click();
  assert.equal(await page.locator("#listRegion").isVisible(), true, "the table returns");
  assert.equal(await opener.evaluate((node) => node === document.activeElement), true, "focus returns to the opener");
});

test("a vendor with nothing recorded has no Relationships section", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { page, section, panel } = await openCard(t, async (route) => {
    await held;
    return answer(nothing)(route);
  });
  await section.locator(".record-note").waitFor();
  release();
  await section.locator(".record-note").waitFor({ state: "detached" });
  await settle(page);
  assert.equal(await section.textContent(), "");
  assert.equal(await section.isVisible(), false);
  assert.doesNotMatch((await panel.locator("#recordBody").textContent()) ?? "", /Relationships|Relationship partner/);
});

test("the card says it is loading, then a failed read says so and Try again reads again", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let fail = true;
  const { section } = await openCard(t, async (route) => {
    await held;
    return fail ? route.fulfill({ status: 500, json: { error: "internal" } }) : answer(relationships)(route);
  });
  assert.equal(await section.locator(".record-note").textContent(), "Loading relationships…");
  release();
  const retry = section.getByRole("button", { name: "Try again" });
  await retry.waitFor();
  assert.equal(await section.locator(".record-note").textContent(), "Couldn't load relationships. Try again");
  fail = false;
  await retry.click();
  await section.locator(".vendor-diagram").waitFor();
});

for (const [width, height] of [
  [1440, 900],
  [1280, 640],
  [390, 844],
] as const)
  test(`the card's relationships fit at ${width}x${height}`, async (t) => {
    const { page, panel, section } = await openCard(t, answer(relationships), { width, height });
    await section.locator(".vendor-diagram").waitFor();
    assert.equal(await panel.evaluate((node) => node.scrollWidth > node.clientWidth), false, "no sideways scroll");
    assert.equal(await section.locator(".client-deal-open").isVisible(), width > 767, "large view is for a computer");
    if (width > 767) {
      await section.locator(".client-deal-open").click();
      const frame = page.locator(".client-deal-opened");
      await frame.locator(".vendor-diagram-links path").first().waitFor({ state: "attached" });
      assert.equal(
        await frame.evaluate((node) => node.scrollWidth > node.clientWidth),
        false,
        "sides fit beside the card",
      );
    }
  });
