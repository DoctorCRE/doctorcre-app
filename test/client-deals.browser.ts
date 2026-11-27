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
// A vendor the synthetic directory holds, so Open lands on a real card.
const titleVendor = "00000000-0000-4000-8000-000000000011";
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
    vendors: [{ party_id: titleVendor, name: "Example Halloran Title", roles: role("Title"), introduction_id: null }],
  }),
];

type Answer = (route: Route) => Promise<void>;
const answer =
  (list: ClientDeal[]): Answer =>
  (route) =>
    route.fulfill({ json: { deals: list } });

async function openCard(
  t: TestContext,
  deals: Answer,
  {
    width = 1440,
    height = 900,
    scheme = "dark",
    saves,
  }: { width?: number; height?: number; scheme?: string; saves?: Answer } = {},
) {
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
  if (saves) {
    await page.route("**/api/engine/deals/*/parties**", (route) => saves(route));
    await page.route("**/api/engine/vendors/summary", (route) =>
      route.fulfill({
        json: {
          all: 3,
          no_category: 0,
          categories: [...role("Lender"), ...role("Title")].map(({ role: slug, label }) => ({ slug, label })),
        },
      }),
    );
    // Party saves follow the Clients and Vendors switch.
    await page.route(
      (url) => url.pathname === "/clients",
      async (route) => {
        const response = await route.fetch();
        const html = (await response.text()).replace("<html ", "<html data-clients-vendors-from-engine ");
        return route.fulfill({ response, body: html });
      },
    );
  }
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

// A made-up engine: the deals read answers what the party saves left, deriving Chosen as the engine does.
function partyEngine(refuse: string | null = null) {
  const list = structuredClone(deals);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const chosen = (d: ClientDeal) =>
    d.introductions.map((i) => ({ ...i, chosen: d.vendors.some((v) => v.party_id === i.vendor_id) }));
  const read: Answer = (route) =>
    route.fulfill({ json: { deals: list.map((d) => ({ ...d, introductions: chosen(d) })) } });
  const save: Answer = (route) => {
    const path = new URL(route.request().url()).pathname;
    const { idempotency_key, ...body } = route.request().postDataJSON();
    assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
    sent.push({ path, body });
    if (refuse) return route.fulfill({ status: 404, json: { error: refuse } });
    const deal = list.find((d) => path.startsWith(`/api/engine/deals/${d.id}/parties`));
    assert.ok(deal, `a known deal: ${path}`);
    deal.vendors = deal.vendors.filter((v) => v.party_id !== body.party_id);
    const intro = deal.introductions.find((i) => i.vendor_id === body.party_id);
    if (!path.endsWith("/remove") && intro)
      deal.vendors.push({
        party_id: intro.vendor_id,
        name: intro.vendor_name,
        roles: role("Lender"),
        introduction_id: intro.id,
      });
    return route.fulfill({ json: { deal_id: deal.id, ...body } });
  };
  return { read, save, sent };
}

async function openParties(t: TestContext, engine = partyEngine(), size = {}) {
  const { page, panel } = await openCard(t, engine.read, { ...size, saves: engine.save });
  const deal = panel.locator(".client-deal").first();
  const box = (name: string) => deal.getByRole("button", { name: new RegExp(`^${name}`) });
  const shows = (name: string, tone: string) => deal.locator(`[data-tone="${tone}"]`, { hasText: name }).waitFor();
  return { page, panel, deal, box, shows, sent: engine.sent };
}

test("Mark chosen puts an introduced vendor on the deal in the role picked, and the box turns chosen", async (t) => {
  const { page, box, shows, sent } = await openParties(t);
  await box("Example Salt Lending").click();
  const menu = page.getByRole("dialog", { name: "Example Salt Lending on Example second office" });
  assert.match((await menu.textContent()) ?? "", /Introduced Oct 14, 2026 by Dell\./);
  assert.equal(await menu.getByRole("button", { name: "Remove from this deal" }).count(), 0, "not on the deal yet");
  await page.screenshot({ path: `${shots}/menu-introduced-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await menu.getByLabel("Chosen as").selectOption({ label: "Lender" });
  await page.screenshot({ path: `${shots}/menu-role-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await shows("Example Salt Lending", "chosen");
  assert.deepEqual(sent, [{ path: "/api/engine/deals/d1/parties", body: { party_id: "v2", role: "lender" } }]);
});

test("Remove asks once, takes the vendor off the deal, and Undo puts them back within 3 seconds", async (t) => {
  const { page, deal, box, shows, sent } = await openParties(t);
  await page.clock.install();
  await box("Example Pelican Bank").click();
  const menu = page.getByRole("dialog", { name: "Example Pelican Bank on Example second office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  assert.match((await menu.textContent()) ?? "", /Remove Example Pelican Bank from Example second office\?/);
  await page.screenshot({ path: `${shots}/menu-confirm-1440-dark.png` });
  assert.equal(sent.length, 0, "nothing is sent before the partner confirms");
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await shows("Example Pelican Bank", "introduced");
  const undo = deal.locator(".client-deal-undo");
  assert.equal(await undo.textContent(), "Removed Example Pelican Bank from Example second office. Undo");
  await page.clock.runFor(2_900);
  await undo.getByRole("button", { name: "Undo" }).click();
  await shows("Example Pelican Bank", "chosen");
  const pelican = { party_id: "v1", role: "lender" };
  assert.deepEqual(sent, [
    { path: "/api/engine/deals/d1/parties/remove", body: pelican },
    { path: "/api/engine/deals/d1/parties", body: pelican },
  ]);
  await box("Example Pelican Bank").click();
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  await undo.waitFor();
  await page.clock.runFor(3_000);
  await undo.waitFor({ state: "detached" });
});

test("Open takes the partner to the vendor's card", async (t) => {
  const { page, panel } = await openParties(t);
  await panel
    .locator(".client-deal")
    .nth(2)
    .getByRole("button", { name: /^Example Halloran Title/ })
    .click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  assert.match((await menu.textContent()) ?? "", /Brought in by: not recorded/);
  await menu.getByRole("link", { name: "Open Example Halloran Title" }).click();
  await page.locator(`#recordBody[data-record-id="${titleVendor}"]`).waitFor();
  assert.equal(new URL(page.url()).pathname, "/vendors");
});

test("a refused save reads plainly and keeps the menu open", async (t) => {
  const { page, deal, box } = await openParties(t, partyEngine("not_found"));
  await box("Example Pelican Bank").click();
  await page.getByRole("button", { name: "Remove from this deal" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const alert = page.locator(".deal-vendor-menu").getByRole("alert");
  assert.equal(await alert.textContent(), "That vendor isn't on this deal anymore.");
  assert.equal(await deal.locator(".client-deal-undo").count(), 0, "no Undo for a removal that did not land");
  await page.screenshot({ path: `${shots}/menu-refused-1440-dark.png` });
});

test("Enter and Space open a vendor's menu, and Esc closes it and returns focus to the box", async (t) => {
  const { page, box } = await openParties(t);
  const pelican = box("Example Pelican Bank");
  for (const key of ["Enter", " "]) {
    await pelican.focus();
    await page.keyboard.press(key);
    const menu = page.locator(".deal-vendor-menu");
    assert.equal(
      await menu.evaluate((node) => node.contains(document.activeElement)),
      true,
      "focus moves into the menu",
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(await pelican.evaluate((node) => node === document.activeElement), true, "focus returns to the box");
    assert.equal(await page.locator("#recordPanel").isVisible(), true, "Esc closes the menu, not the card");
  }
});

test("without party saves a vendor box is a label", async (t) => {
  const { panel } = await openCard(t, answer(deals));
  await panel.locator(".client-deal").first().waitFor();
  assert.equal(await panel.locator(".deal-diagram [role='button']").count(), 0);
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`a vendor's menu fits at ${width}x${height} ${scheme}`, async (t) => {
    const { page, box } = await openParties(t, partyEngine(), { width, height, scheme });
    await box("Example Salt Lending").click();
    const { left, right } = await page
      .locator(".deal-vendor-menu")
      .evaluate((node) => node.getBoundingClientRect().toJSON());
    assert.ok(left >= 0 && right <= width, `the menu stays on screen (${left} to ${right})`);
    const sideways = await page.locator("#recordPanel").evaluate((node) => node.scrollWidth > node.clientWidth);
    assert.equal(sideways, false, "the open menu never makes the card scroll sideways");
    await page.screenshot({ path: `${shots}/menu-${width}-${scheme}.png` });

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
