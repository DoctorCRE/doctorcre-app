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
  { width = 1440, height = 900, scheme = "dark", saves = null as Answer | null } = {},
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

// A made-up engine: the deals read answers what the deal party saves left, deriving Chosen as the engine does.
function partyEngine(refuse: string | null = null) {
  const list = structuredClone(deals);
  const sent: { path: string; body: Record<string, unknown> }[] = [];
  const read: Answer = (route) =>
    route.fulfill({
      json: {
        deals: list.map((d) => ({
          ...d,
          introductions: d.introductions.map((i) => ({
            ...i,
            chosen: d.vendors.some((v) => v.party_id === i.vendor_id),
          })),
        })),
      },
    });
  const save: Answer = (route) => {
    const path = new URL(route.request().url()).pathname;
    const { idempotency_key, ...body } = route.request().postDataJSON();
    assert.match(String(idempotency_key), /^[0-9a-f-]{36}$/);
    sent.push({ path, body });
    if (refuse) return route.fulfill({ status: 404, json: { error: refuse } });
    const deal = list.find(
      (d) => path === `/api/engine/deals/${d.id}/parties` || path === `/api/engine/deals/${d.id}/parties/remove`,
    );
    assert.ok(deal, `a known deal: ${path}`);
    const intro = deal.introductions.find((i) => i.vendor_id === body.party_id);
    if (path.endsWith("/remove")) deal.vendors = deal.vendors.filter((v) => v.party_id !== body.party_id);
    else
      deal.vendors.push({
        party_id: String(body.party_id),
        name: intro?.vendor_name ?? "Example vendor",
        roles: role(String(body.role).replace(/^./, (c) => c.toUpperCase())),
        introduction_id: intro?.id ?? null,
      });
    return route.fulfill({ status: path.endsWith("/remove") ? 200 : 201, json: { deal_id: deal.id, ...body } });
  };
  return { read, save, sent };
}

const firstDeal = (panel: Locator) => panel.locator(".client-deal").first();
const vendorBox = (panel: Locator, name: string) =>
  firstDeal(panel).getByRole("button", { name: new RegExp(`^${name}`) });
const toneOf = (box: Locator) => box.getAttribute("data-tone");

test("Mark chosen puts an introduced vendor on the deal in the role picked, and the box turns chosen", async (t) => {
  const engine = partyEngine();
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  const box = vendorBox(panel, "Example Salt Lending");
  assert.equal(await toneOf(box), "introduced");
  await box.click();
  const menu = page.getByRole("dialog", { name: "Example Salt Lending on Example second office" });
  assert.match((await menu.textContent()) ?? "", /Dell introduced them Oct 14, 2026\./);
  assert.equal(await menu.getByRole("button", { name: "Remove from this deal" }).count(), 0, "not on the deal yet");
  await page.screenshot({ path: `${shots}/menu-introduced-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await menu.getByLabel("Chosen as").selectOption({ label: "Lender" });
  await page.screenshot({ path: `${shots}/menu-role-1440-dark.png` });
  await menu.getByRole("button", { name: "Mark chosen" }).click();
  await menu.waitFor({ state: "detached" });
  assert.deepEqual(engine.sent, [{ path: "/api/engine/deals/d1/parties", body: { party_id: "v2", role: "lender" } }]);
  await page.waitForFunction(() =>
    [...(document.querySelector(".client-deal")?.querySelectorAll("[data-tone='chosen']") ?? [])].some((n) =>
      n.textContent?.includes("Example Salt Lending"),
    ),
  );
});

test("Remove asks once, takes the vendor off the deal, and Undo puts them back", async (t) => {
  const engine = partyEngine();
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  await vendorBox(panel, "Example Pelican Bank").click();
  const menu = page.getByRole("dialog", { name: "Example Pelican Bank on Example second office" });
  await menu.getByRole("button", { name: "Remove from this deal" }).click();
  assert.match((await menu.textContent()) ?? "", /Remove Example Pelican Bank from Example second office\?/);
  await page.screenshot({ path: `${shots}/menu-confirm-1440-dark.png` });
  assert.equal(engine.sent.length, 0, "nothing is sent before the partner confirms");
  await menu.getByRole("button", { name: "Remove", exact: true }).click();
  const undo = firstDeal(panel).locator(".client-deal-undo");
  await undo.waitFor();
  assert.equal(await undo.textContent(), "Removed Example Pelican Bank from Example second office. Undo");
  await page.waitForFunction(() =>
    [...(document.querySelector(".client-deal")?.querySelectorAll("[data-tone='introduced']") ?? [])].some((n) =>
      n.textContent?.includes("Example Pelican Bank"),
    ),
  );
  await undo.getByRole("button", { name: "Undo" }).click();
  await page.waitForFunction(() =>
    [...(document.querySelector(".client-deal")?.querySelectorAll("[data-tone='chosen']") ?? [])].some((n) =>
      n.textContent?.includes("Example Pelican Bank"),
    ),
  );
  assert.deepEqual(engine.sent, [
    { path: "/api/engine/deals/d1/parties/remove", body: { party_id: "v1", role: "lender" } },
    { path: "/api/engine/deals/d1/parties", body: { party_id: "v1", role: "lender" } },
  ]);
});

test("Undo after a removal is offered for 3 seconds", async (t) => {
  const engine = partyEngine();
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  await page.clock.install();
  await vendorBox(panel, "Example Pelican Bank").click();
  await page.getByRole("button", { name: "Remove from this deal" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const undo = firstDeal(panel).locator(".client-deal-undo");
  await undo.waitFor();
  await page.clock.runFor(2_900);
  assert.equal(await undo.count(), 1, "still there just before 3 seconds");
  await page.clock.runFor(200);
  await undo.waitFor({ state: "detached" });
});

test("Open takes the partner to the vendor's card", async (t) => {
  const engine = partyEngine();
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  await panel
    .locator(".client-deal")
    .nth(2)
    .getByRole("button", { name: /^Example Halloran Title/ })
    .click();
  const menu = page.getByRole("dialog", { name: "Example Halloran Title on Example first office" });
  assert.match((await menu.textContent()) ?? "", /Brought in by: not recorded/);
  await menu.getByRole("link", { name: "Open Example Halloran Title" }).click();
  await page.waitForFunction(
    (id) => location.pathname === "/vendors" && new URLSearchParams(location.search).get("record") === id,
    titleVendor,
  );
  await page.locator(`#recordBody[data-record-id="${titleVendor}"]`).waitFor();
});

test("a refused save reads plainly and keeps the menu open", async (t) => {
  const engine = partyEngine("not_found");
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  await vendorBox(panel, "Example Pelican Bank").click();
  await page.getByRole("button", { name: "Remove from this deal" }).click();
  await page.getByRole("button", { name: "Remove", exact: true }).click();
  const alert = page.locator(".deal-vendor-menu").getByRole("alert");
  await alert.waitFor();
  assert.equal(await alert.textContent(), "That vendor isn't on this deal anymore.");
  assert.equal(
    await firstDeal(panel).locator(".client-deal-undo").count(),
    0,
    "no Undo for a removal that did not land",
  );
  await page.screenshot({ path: `${shots}/menu-refused-1440-dark.png` });
});

test("Enter and Space open a vendor's menu and Esc closes it and returns focus to the box", async (t) => {
  const engine = partyEngine();
  const { page, panel } = await openCard(t, engine.read, { saves: engine.save });
  const box = vendorBox(panel, "Example Pelican Bank");
  for (const key of ["Enter", " "]) {
    await box.focus();
    await page.keyboard.press(key);
    const menu = page.locator(".deal-vendor-menu");
    await menu.waitFor();
    assert.equal(await box.getAttribute("aria-expanded"), "true");
    assert.equal(
      await menu.evaluate((node) => node.contains(document.activeElement)),
      true,
      "focus moves into the menu",
    );
    await page.keyboard.press("Escape");
    await menu.waitFor({ state: "detached" });
    assert.equal(
      await box.evaluate((node) => node === document.activeElement),
      true,
      `${key}: focus returns to the box`,
    );
    assert.equal(await page.locator("#recordPanel").isVisible(), true, "Esc closes the menu, not the card");
  }
});

test("without party saves a vendor box is a label", async (t) => {
  const { panel } = await openCard(t, answer(deals));
  await firstDeal(panel).waitFor();
  assert.equal(await firstDeal(panel).locator(".deal-diagram [role='button']").count(), 0);
});

for (const [width, height, scheme] of [
  [1440, 900, "light"],
  [1280, 640, "dark"],
  [1280, 640, "light"],
  [390, 844, "dark"],
  [390, 844, "light"],
] as const)
  test(`a vendor's menu fits at ${width}x${height} ${scheme}`, async (t) => {
    const engine = partyEngine();
    const { page, panel } = await openCard(t, engine.read, { width, height, scheme, saves: engine.save });
    await vendorBox(panel, "Example Salt Lending").click();
    const menu = page.locator(".deal-vendor-menu");
    await menu.waitFor();
    const { left, right } = await menu.evaluate((node) => node.getBoundingClientRect().toJSON());
    assert.ok(left >= 0 && right <= width, `the menu stays on screen (${left} to ${right})`);
    await page.screenshot({ path: `${shots}/menu-${width}-${scheme}.png` });
  });
