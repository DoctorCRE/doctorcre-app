import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Route } from "playwright";
import type { ClientDeal } from "../src/ui/deal-diagram.tsx";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/client-deals";
await mkdir(shots, { recursive: true });
const recordId = "00000000-0000-4000-8000-000000000001";
const role = (label: string) => [{ role: label.toLowerCase(), label }];
const deal = (id: string, name: string, parts: Partial<ClientDeal>): ClientDeal => ({
  id,
  name,
  phase: "negotiation",
  phase_label: "Negotiation",
  open: true,
  closed_on: null,
  owner: "dell",
  vendors: [],
  introductions: [],
  ...parts,
});
const introduction = (vendor_id: string, vendor_name: string, chosen: boolean) => ({
  id: `i-${vendor_id}`,
  vendor_id,
  vendor_name,
  made_by: "team" as const,
  introduced_by: "dell" as const,
  introduced_party_id: recordId,
  introduced_party_name: "Example client",
  introduced_on: "2026-10-14",
  note: null,
  chosen,
});
const deals: ClientDeal[] = [
  deal("d1", "Example second office", {
    vendors: [{ party_id: "v1", name: "Example Pelican Bank", roles: role("Lender"), introduction_id: "i-v1" }],
    introductions: [
      introduction("v1", "Example Pelican Bank", true),
      introduction("v2", "Example Salt Lending", false),
    ],
  }),
  deal("d2", "Example third office", { owner: "joe", phase_label: "Touring" }),
  deal("d3", "Example first office", {
    open: false,
    closed_on: "2024-03-01",
    phase_label: "Closed",
    vendors: [{ party_id: "v3", name: "Example Halloran Title", roles: role("Title"), introduction_id: null }],
  }),
];

type Answer = (route: Route) => Promise<void>;
const answer =
  (list: ClientDeal[]): Answer =>
  (route) =>
    route.fulfill({ json: { deals: list } });

async function openCard(t: TestContext, deals: Answer, { width = 1440, height = 900, scheme = "dark" } = {}) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await page.addInitScript((theme) => {
    localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
  }, scheme);
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }));
  await page.route("**/api/engine/clients/*/deals", (route) => deals(route));
  await page.goto(`${server.url}/clients?all=true&record=${recordId}&mode=live`);
  const panel = page.locator("#recordPanel");
  await panel.locator("#recordActivity").waitFor();
  return { page, panel };
}

const dealHeads = (panel: Locator) =>
  panel.locator(".client-deal > .client-deal-head").evaluateAll((heads) => heads.map((head) => head.textContent));

test("a client's card draws each of its deals, open deals first, with the closed month on a past deal", async (t) => {
  const { page, panel } = await openCard(t, answer(deals));
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deals-section > h3").textContent(), "Deals");
  assert.deepEqual(await dealHeads(panel), [
    "Example second officeNegotiation",
    "Example third officeTouring",
    "Example first officeClosed Mar 2024",
  ]);
  assert.equal(await panel.locator(".client-deal a").first().getAttribute("href"), "/deals?deal=d1");
  assert.equal(await panel.locator(".client-deal .deal-diagram").count(), 3);
  await page.screenshot({ path: `${shots}/card-1440-dark.png` });
});

test("opening a deal shows it large in place of the table, and the x brings the table back", async (t) => {
  const { page, panel } = await openCard(t, answer(deals));
  const opener = panel.getByRole("button", { name: "Open Example second office large" });
  await opener.click();
  const opened = page.locator(".client-deal-opened");
  await opened.waitFor();
  assert.equal(await page.locator("#listRegion").isVisible(), false, "the table steps aside");
  assert.equal(await panel.isVisible(), true, "the card stays beside it");
  assert.deepEqual(
    await opened.locator(".deal-diagram-date").allTextContents(),
    ["Introduced Oct 14, 2026", "Introduced Oct 14, 2026"],
    "dates sit under each introduced name",
  );
  await page.screenshot({ path: `${shots}/opened-1440-dark.png` });
  await opened.getByRole("button", { name: "Back to the table" }).click();
  assert.equal(await opened.count(), 0);
  assert.equal(await page.locator("#listRegion").isVisible(), true, "the table returns");
  assert.equal(await opener.evaluate((node) => node === document.activeElement), true, "focus returns to the opener");
});

test("a client's card shows no Deals heading until the read answers with a deal", async (t) => {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const { panel } = await openCard(t, async (route) => {
    await held;
    return answer(deals)(route);
  });
  await panel.locator(".client-deals-section").waitFor({ state: "attached" });
  assert.equal(await panel.locator(".client-deals-section").textContent(), "", "nothing while the read is out");
  release();
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deals-section > h3").textContent(), "Deals");
});

test("a client with no deals never shows a Deals section", async (t) => {
  let answered = () => {};
  const read = new Promise<void>((resolve) => {
    answered = resolve;
  });
  const { page, panel } = await openCard(t, async (route) => {
    await answer([])(route);
    answered();
  });
  await panel.locator(".client-deals-section").waitFor({ state: "attached" });
  await read;
  await page.evaluate(() => new Promise((frame) => requestAnimationFrame(() => requestAnimationFrame(frame))));
  assert.equal(await panel.locator(".client-deals-section").textContent(), "");
  assert.doesNotMatch((await panel.locator("#recordBody").textContent()) ?? "", /Deals/);
});

test("a failed deals read says so plainly and Try again reads them again", async (t) => {
  let fail = true;
  const { panel } = await openCard(t, (route) =>
    fail ? route.fulfill({ status: 500, json: { error: "internal" } }) : answer(deals)(route),
  );
  const retry = panel.getByRole("button", { name: "Try again" });
  await retry.waitFor();
  assert.equal(
    await panel.locator(".client-deals-section .record-note").textContent(),
    "Couldn't load deals. Try again",
  );
  fail = false;
  await retry.click();
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".client-deal").count(), 3);
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`the card's deals fit at ${width}x${height} ${scheme}`, async (t) => {
    const { page, panel } = await openCard(t, answer(deals), { width, height, scheme });
    await panel.locator(".client-deal").first().waitFor();
    const sideways = await panel.evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(sideways, false, "nothing in the card scrolls sideways");
    assert.equal(
      await panel.locator(".client-deal-open").first().isVisible(),
      width > 767,
      "large view is for a computer",
    );
    const [name, phase] = await panel
      .locator(".client-deal-head")
      .first()
      .evaluate((head) =>
        [...head.querySelectorAll("a, span")].map((node) => {
          const range = document.createRange();
          range.selectNodeContents(node);
          const { top, height } = range.getBoundingClientRect();
          return top + height / 2;
        }),
      );
    assert.ok(
      Math.abs((name ?? 0) - (phase ?? 0)) <= 1,
      `the phase sits level with the deal name (${name} vs ${phase})`,
    );
    await page.screenshot({ path: `${shots}/card-${width}-${scheme}.png` });
    if (width > 767) {
      await panel.locator(".client-deal-open").first().click();
      await page.locator(".client-deal-opened").waitFor();
      await page.screenshot({ path: `${shots}/opened-${width}-${scheme}.png` });
    }
  });

const longName = "Example Brand - Example Deal 2 - EXAMPLE CITY ST";
for (const [width, height, scheme] of [
  [1280, 599, "dark"],
  [1280, 599, "light"],
  [1440, 900, "dark"],
  [1440, 900, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`a long deal name never widens the card at ${width}x${height} ${scheme}`, async (t) => {
    const long = [deal("d1", longName, { phase_label: "Letter of intent" })];
    const { page, panel } = await openCard(t, answer(long), { width, height, scheme });
    await panel.locator(".client-deal").first().waitFor();
    const inside = await panel.evaluate((node, wide) => {
      const card = node.getBoundingClientRect();
      const fits = (selector: string) => {
        const box = node.querySelector(selector)?.getBoundingClientRect();
        return !!box && box.width > 0 && box.left >= card.left && box.right <= card.right;
      };
      return {
        sideways: node.scrollWidth > node.clientWidth,
        phase: fits(".client-deal-head > span"),
        diagram: fits(".client-deal .deal-diagram"),
        open: !wide || fits(".client-deal-open"),
      };
    }, width > 767);
    assert.deepEqual(inside, { sideways: false, phase: true, diagram: true, open: true });
    assert.equal(await panel.locator(".client-deal-head a").first().getAttribute("title"), longName);
    await page.screenshot({ path: `${shots}/long-name-${width}-${scheme}.png` });
  });
