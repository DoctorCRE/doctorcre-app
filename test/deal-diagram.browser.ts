import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import type { DealDiagram } from "../src/ui/deal-diagram.tsx";
import { chromium, componentDocument } from "./browser-harness.mjs";

const shots = "out/test-artifacts/deal-diagram";
await mkdir(shots, { recursive: true });
const assets = await appAssetSnapshot();
const vendor = (id: string, name: string, role: string, chosen = false) => ({ id, name, role, chosen });
const fullDeal: DealDiagram = {
  client: "Example Harbor Dental",
  owner: "dell",
  referredBy: [{ id: "r1", name: "Example Renata Ossa", role: "Attorney" }],
  introducedBy: {
    dell: [
      vendor("v1", "Example Saltmarsh Lending", "Lender"),
      vendor("v2", "Example Pelican Ridge Bank", "Lender", true),
      vendor("v3", "Example Corwin Build Co.", "Contractor"),
      vendor("v4", "Example Longleaf Construction", "Contractor"),
    ],
    joe: [vendor("v5", "Example Dana Whitlock", "Attorney", true)],
  },
  clientBrought: [vendor("v6", "Example Marsh & Lane CPAs", "CPA", true)],
  notRecorded: [{ id: "v7", name: "Example Halloran Title & Law", role: "Title" }],
};
const longNameDeal: DealDiagram = {
  ...fullDeal,
  introducedBy: {
    dell: [
      vendor("l1", "Example Northwind Harbor Commercial Mortgage and Equipment Finance Partners", "Lender"),
      vendor("l2", "Example Pelican Ridge Bank", "Lender"),
      vendor("l3", "Example Corwin Build Co.", "Contractor"),
    ],
  },
  clientBrought: [],
  notRecorded: [],
};
const emptyDeal: DealDiagram = {
  client: "Example Bayline Dental",
  owner: "joe",
  referredBy: [],
  introducedBy: {},
  clientBrought: [],
  notRecorded: [],
};

async function open(
  t: TestContext,
  diagrams: DealDiagram[],
  { width = 1440, height = 772, theme = "dark", assist = false } = {},
) {
  const server = await startWorkerFixture({ routes: assets });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  const card = width > 600 ? "width:400px;margin:24px" : "margin:0";
  await componentDocument(page, server.origin, {
    html: `<!doctype html><html data-theme="${theme}"${assist ? ' data-color-assist="on"' : ""}><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/workspace-business.css"><body style="margin:0;background:var(--ground);color:var(--fg);font-family:var(--font-text)"><main style="${card};padding:16px;background:var(--surface-1);border-radius:10px;display:grid;grid-template-columns:minmax(0,1fr);gap:24px"></main>`,
    dispose: () =>
      mounted.evaluate((list: { dispose(): void }[]) => {
        for (const diagram of list) diagram.dispose();
      }),
  });
  const mounted = await page.evaluateHandle(async (diagrams) => {
    const { mountDealDiagram } = await import(String("/js/ui-deal-diagram.generated.js"));
    const main = document.querySelector("main");
    if (!main) throw new Error("No card to mount the diagrams in");
    return diagrams.map((diagram) => mountDealDiagram(main.appendChild(document.createElement("section")), diagram));
  }, diagrams);
  return page;
}

const boxes = (page: Page) =>
  page
    .locator(".deal-diagram-box")
    .evaluateAll((nodes) =>
      nodes.map((node) =>
        [...node.querySelectorAll(".deal-diagram-text > *")].map((part) => part.textContent).join(" | "),
      ),
    );

test("a deal's diagram hangs each vendor under who brought them, with its role and state", async (t) => {
  const page = await open(t, [fullDeal]);
  assert.deepEqual(await boxes(page), [
    "Example Harbor Dental | Client",
    "Example Renata Ossa | Attorney · Referred this client",
    "Dell | Deal owner",
    "Example Pelican Ridge Bank | Lender · Chosen",
    "Example Saltmarsh Lending | Lender · Introduced",
    "Joe | Introduced",
    "Example Dana Whitlock | Attorney · Chosen",
    "Example Marsh & Lane CPAs | CPA · Chosen",
    "Example Halloran Title & Law | Title · On the deal",
  ]);
  assert.equal(await page.locator(".deal-diagram-junction > span").textContent(), "Brought in by: not recorded");
  const line = (name: string) =>
    page.evaluate((name) => {
      const box = [...document.querySelectorAll(".deal-diagram-box b")].find((b) => b.textContent === name);
      const branch = box?.closest("li");
      if (!branch) throw new Error(`No branch for ${name}`);
      const style = getComputedStyle(branch, "::before");
      return { color: style.borderLeftColor, style: style.borderLeftStyle };
    }, name);
  const chosen = await line("Example Pelican Ridge Bank");
  const plain = await line("Dell");
  assert.notEqual(chosen.color, plain.color);
  assert.equal(chosen.style, "solid");
  assert.equal((await line("Example Halloran Title & Law")).style, "dashed");
});

test("introduced vendors stack like a pile and fan out with one click, then stack again", async (t) => {
  const page = await open(t, [fullDeal]);
  const pile = page.getByRole("button", { name: "Show all 3 introduced vendors" });
  assert.equal(await pile.getAttribute("aria-expanded"), "false");
  assert.equal(await pile.locator(".deal-diagram-count").textContent(), "+2");
  assert.equal(await page.locator('[data-tone="introduced"]').count(), 1);
  await pile.click();
  assert.equal(await page.locator('[data-tone="introduced"]').count(), 3);
  const focused = () => page.evaluate(() => document.activeElement?.textContent ?? document.activeElement?.tagName);
  assert.match(String(await focused()), /Saltmarsh Lending/);
  const restack = page.getByRole("button", { name: "Stack the 3 introduced" });
  assert.equal(await restack.getAttribute("aria-expanded"), "true");
  await page.screenshot({ path: `${shots}/fanned-1440-dark.png` });
  await restack.click();
  assert.equal(await page.locator('[data-tone="introduced"]').count(), 1);
  assert.equal(await pile.isVisible(), true);
  assert.equal(await pile.evaluate((node) => node === document.activeElement), true);
});

test("the pile's label tells a screen reader the top vendor, its role and state, and the count", async (t) => {
  const page = await open(t, [fullDeal]);
  const label = await page.locator(".deal-diagram-pile").getAttribute("aria-label");
  assert.equal(label, "Show all 3 introduced vendors, starting with Example Saltmarsh Lending, Lender, introduced");
});

test("the restack button is a full control height", async (t) => {
  const page = await open(t, [fullDeal]);
  await page.locator(".deal-diagram-pile").click();
  const box = await page.getByRole("button", { name: "Stack the 3 introduced" }).boundingBox();
  const touch = await page.evaluate(() =>
    Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue("--touch")),
  );
  assert.ok(box && touch > 0 && box.height >= touch, `restack is ${box?.height}px, control size is ${touch}px`);
});

test("a deal with no vendors shows the client and the deal owner only", async (t) => {
  const page = await open(t, [emptyDeal]);
  assert.deepEqual(await boxes(page), ["Example Bayline Dental | Client", "Joe | Deal owner"]);
  assert.equal(await page.locator(".deal-diagram ul ul").count(), 0);
});

for (const [width, theme] of [
  [1440, "light"],
  [1440, "dark"],
  [390, "light"],
  [390, "dark"],
] as const)
  test(`the +N pill never covers a long top vendor name at ${width}px ${theme}`, async (t) => {
    const page = await open(t, [longNameDeal], { width, theme });
    const { name, count } = await page.evaluate(() => {
      const rect = (selector: string) => {
        const node = document.querySelector(selector);
        if (!node) throw new Error(`No ${selector}`);
        const { left, right } = node.getBoundingClientRect();
        return { left, right };
      };
      return { name: rect(".deal-diagram-pile .deal-diagram-text"), count: rect(".deal-diagram-count") };
    });
    assert.ok(name.right <= count.left + 0.5, `name ends at ${name.right}, pill starts at ${count.left}`);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: `${shots}/long-name-${width}-${theme}.png`, fullPage: true });
    await page.locator(".deal-diagram-pile").click();
    await page.screenshot({ path: `${shots}/long-name-${width}-${theme}-fanned.png`, fullPage: true });
    await page.getByRole("button", { name: "Stack the 3 introduced" }).click();
    await page.screenshot({ path: `${shots}/long-name-${width}-${theme}-restacked.png`, fullPage: true });
  });

const sizes = [
  { width: 1440, height: 772 },
  { width: 1280, height: 640 },
  { width: 390, height: 844 },
];
for (const size of sizes)
  for (const theme of ["dark", "light"])
    test(`the diagram fits at ${size.width}x${size.height} ${theme} with no overlapping boxes`, async (t) => {
      const page = await open(t, [fullDeal, emptyDeal], { ...size, theme, assist: size.width === 1280 });
      const fit = await page.evaluate(() => {
        const rects = [...document.querySelectorAll(".deal-diagram-box")].map((box) => box.getBoundingClientRect());
        const main = document.querySelector("main")?.getBoundingClientRect();
        if (!main) throw new Error("No card");
        const overlaps = rects.filter((a, i) =>
          rects.some((b, j) => i < j && a.bottom > b.top + 1 && b.bottom > a.top + 1),
        );
        return {
          overlaps: overlaps.length,
          outside: rects.filter((r) => r.left < main.left || r.right > main.right).length,
          pageScrolls: document.documentElement.scrollWidth > innerWidth,
        };
      });
      assert.deepEqual(fit, { overlaps: 0, outside: 0, pageScrolls: false });
      await page.screenshot({ path: `${shots}/diagram-${size.width}x${size.height}-${theme}.png`, fullPage: true });
    });
