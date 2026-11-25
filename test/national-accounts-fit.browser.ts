import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { ownedFixtureServer } from "./fixture-probe.ts";

const shots = "out/test-artifacts/national-accounts-fit";
await mkdir(shots, { recursive: true });

type Open = { width: number; height: number; theme?: "light" | "dark"; today?: "open"; phone?: boolean };

async function openAccount(t: TestContext, { width, height, theme = "light", today, phone = false }: Open) {
  const server = await ownedFixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
    ...(phone ? { isMobile: true, hasTouch: true } : {}),
  });
  await page.addInitScript(
    ([theme, today]) => {
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme }));
      if (today) localStorage.setItem("doctorcre:today:/deals?view=national", today);
    },
    [theme, today],
  );
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?view=national&mode=fixture`);
  await page.locator(".account-card").first().click();
  await page.locator("#rows tr").first().waitFor();
  return page;
}

const firstScreen = (page: Page) =>
  page.evaluate(() => {
    const main = document.getElementById("appMainSlot");
    if (!main) throw Error("no main region");
    return {
      pageScrolls: document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      mainTop: Math.round(main.getBoundingClientRect().top + Number.parseFloat(getComputedStyle(main).paddingTop)),
      headings: [...document.querySelectorAll("h1")].map((heading) => heading.textContent?.trim()),
    };
  });

const shown = (page: Page, selector: string) =>
  page.locator(selector).evaluate((node) => getComputedStyle(node).opacity === "1");

for (const [width, height] of [
  [1200, 750],
  [1280, 679],
  [1280, 800],
  [1366, 768],
  [1440, 900],
] as const) {
  test(`a national account fits one screen with one toolbar row at ${width}x${height}`, async (t) => {
    const page = await openAccount(t, { width, height });
    await page.screenshot({ path: `${shots}/account-${width}-light.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.mainTop <= 112, `the deals start under one toolbar row, not at ${fit.mainTop}px`);
    assert.deepEqual(fit.headings, ["Demo National Practice"], "the account is named once, in the top bar");
    const tools = page.locator("#appToolsSlot");
    for (const control of ["#accountBack", "#ownerButton", "#dealFilter", "#search", "#stickyAddButton"])
      assert.ok(await tools.locator(control).isVisible(), `${control} sits in the toolbar`);
  });

  test(`a national account fits beside an open Today at ${width}x${height}`, async (t) => {
    const page = await openAccount(t, { width, height, theme: "dark", today: "open" });
    await page.screenshot({ path: `${shots}/account-${width}-today-dark.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.mainTop <= 112, `the toolbar stays one row beside Today, deals at ${fit.mainTop}px`);
    assert.equal(
      await page.locator("#search").evaluate((input: HTMLInputElement) => {
        const style = getComputedStyle(input);
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw Error("no canvas");
        context.font = style.font;
        const room = input.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight);
        return context.measureText(input.placeholder).width <= room;
      }),
      true,
      "the search box shows its whole placeholder",
    );
  });
}

test("deal rows stay quiet until hovered or reached by keyboard, and Park still works", async (t) => {
  const page = await openAccount(t, { width: 1440, height: 900 });
  const row = page.locator("#rows tr").first();
  const park = row.locator("[data-operating-state]");
  await page.mouse.move(0, 0);
  assert.equal(await shown(page, "#rows tr:first-child [data-operating-state]"), false, "Park waits off the quiet row");
  assert.equal(
    await row.locator("[data-phase]").evaluate((node) => getComputedStyle(node).appearance),
    "none",
    "the phase reads as text",
  );
  await row.hover();
  assert.equal(await shown(page, "#rows tr:first-child [data-operating-state]"), true, "hover shows Park");
  await page.screenshot({ path: `${shots}/row-hover-1440.png` });
  await page.mouse.move(0, 0);
  await row.locator("[data-market-agent]").focus();
  await page.keyboard.press("Tab");
  assert.equal(await park.evaluate((node) => node === document.activeElement), true, "Tab reaches Park");
  assert.equal(await shown(page, "#rows tr:first-child [data-operating-state]"), true, "focus shows Park");
  await page.keyboard.press("Enter");
  await page.locator("#formDialog[open]").waitFor();
});

test("the Show filter is labeled, narrows an account's deals to parked ones, and looks set while it narrows", async (t) => {
  const page = await openAccount(t, { width: 1280, height: 800 });
  const show = page.getByLabel("Show", { exact: true });
  const look = () => show.evaluate((node) => getComputedStyle(node).borderColor);
  assert.ok(
    await page.locator("#appToolsSlot").getByText("Show", { exact: true }).isVisible(),
    "Show is a visible label",
  );
  const active = await page.locator("#rows tr").count();
  const plain = await look();
  await show.selectOption({ label: "Parked" });
  await page.locator("#emptyState").getByText("No parked deals.").waitFor();
  assert.notEqual(await look(), plain, "a narrowing choice does not look like Active");
  await show.selectOption({ label: "Active" });
  assert.equal(await page.locator("#rows tr").count(), active);
  assert.equal(await look(), plain);
});

test("on a phone each deal keeps Park in reach without hover", async (t) => {
  const page = await openAccount(t, { width: 390, height: 844, phone: true });
  await page.screenshot({ path: `${shots}/account-390-light.png` });
  assert.equal((await firstScreen(page)).sideways, false, "nothing scrolls sideways");
  assert.equal(await shown(page, "#rows tr:first-child [data-operating-state]"), true, "Park shows on touch");
  const park = await page.locator("#rows tr:first-child [data-operating-state]").boundingBox();
  assert.ok(park && park.height >= 44, "Park is a full touch target");
});

test("on a phone every Today card on Deals stays inside the panel's gutter", async (t) => {
  const server = await ownedFixtureServer();
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width: 390, height: 844 },
    isMobile: true,
    hasTouch: true,
    reducedMotion: "reduce",
  });
  await page.route("**/api/**", (route) => route.fulfill({ json: {} }));
  await page.goto(`${server.origin}/deals?mode=fixture`);
  await page.getByRole("button", { name: "Today sidebar", exact: true }).click();
  const today = page.getByRole("complementary", { name: "Today", exact: true });
  await today.locator(".receipt").first().waitFor();
  await page.locator('#appLayout[data-drawer="today"]').waitFor();
  await page.screenshot({ path: `${shots}/today-deals-390.png` });
  const outside = await today.evaluate((panel) => {
    const edge = panel.getBoundingClientRect();
    return [...panel.children].flatMap((card) => {
      const box = card.getBoundingClientRect();
      return card.checkVisibility() && (box.left < edge.left + 15 || box.right > edge.right - 15)
        ? [card.id || card.className]
        : [];
    });
  });
  assert.deepEqual(outside, [], "Retry Today and Recent changes keep the panel's side gutter");
});
