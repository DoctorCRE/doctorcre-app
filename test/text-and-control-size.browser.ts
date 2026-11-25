import assert from "node:assert/strict";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";

// Design rules 1 and 4: sizes follow the pointer, not the width. A mouse or trackpad gets 14px body text and
// 28-32px controls at any width; a touch screen gets 16px and 44px touch targets.
const screens = {
  Home: "/?mode=fixture",
  Deals: "/deals?mode=fixture",
  "deal page": "/deals?mode=fixture&deal=d14",
  Leads: "leads",
  Vendors: "/vendors?mode=fixture",
  Calendar: "/calendar?mode=fixture",
  Search: "/search?mode=fixture",
  Settings: "/settings?mode=fixture",
};
const pointers = [
  { width: 1280, touch: false, body: "14px", fits: (h: number) => h >= 28 && h <= 32 },
  { width: 1440, touch: false, body: "14px", fits: (h: number) => h >= 28 && h <= 32 },
  { width: 800, touch: false, body: "14px", fits: (h: number) => h >= 28 && h <= 32 },
  { width: 390, touch: true, body: "16px", fits: (h: number) => h >= 44 },
  { width: 1280, touch: true, body: "16px", fits: (h: number) => h >= 44 },
];
const interactive =
  "a[href], button, select, summary, input:not([type=checkbox], [type=radio], [type=hidden]), [role=button], [role=tab]";
// Not controls: deal cards and Today reminder rows are rows, a heading's link is its title, calendar days are a
// grid, map pins mark places.
const notControls = ".card-open, a.app-layout-item, :is(h1, h2, h3, h4) a, [class^=cal-], .market-marker";

test("body text and controls take their size from the pointer on every screen", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const { width, touch, body, fits } of pointers)
    for (const [name, path] of Object.entries(screens))
      await t.test(`${name} at ${width} with ${touch ? "touch" : "a mouse"}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch });
        t.after(() => page.close());
        if (path === "leads") {
          await routeLeads(page);
          await page.goto("http://localhost/leads");
          await page.locator("#leadBoard .lead-card").first().waitFor();
        } else {
          await page.route("https://**", (route) => route.abort());
          await page.goto(server.origin + path);
          await page.locator("main").first().waitFor();
        }
        await page.waitForLoadState("networkidle");
        const sizes = await page.evaluate(
          ({ interactive, notControls }) => ({
            body: getComputedStyle(document.body).fontSize,
            controls: [...document.querySelectorAll(interactive)]
              // A link inside a sentence is text, not a control.
              .filter((node) => !node.matches(notControls) && getComputedStyle(node).display !== "inline")
              .map((node) => ({ node, box: node.getBoundingClientRect() }))
              // A skip link waits above the page until it has focus.
              .filter(({ box }) => box.height > 0 && box.bottom > 0)
              .map(({ node, box }) => ({
                name: `${node.tagName.toLowerCase()}#${node.id}.${node.className}`,
                height: Math.round(box.height),
              })),
          }),
          { interactive, notControls },
        );
        assert.equal(sizes.body, body, "body text");
        assert.ok(sizes.controls.length > 0, "the screen shows controls");
        assert.deepEqual(
          sizes.controls.filter((control) => !fits(control.height)),
          [],
          `every control is the token height at ${width}`,
        );
      });
});

test("a button whose label wraps keeps its text off the border", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const label = "Send the tour plan to every vendor on the list";
  const buttons = {
    "/deals?mode=fixture": [`<div class="deal-tours"><a class="btn" href="/">${label}</a></div>`],
    "/?mode=fixture": [
      `<div class="inbox-shell"><div class="inbox-row-explained"><div class="inbox-actions"><button style="white-space: normal">${label}</button></div></div></div>`,
    ],
  };

  for (const { width, touch } of [
    { width: 1280, touch: false },
    { width: 390, touch: true },
  ])
    for (const [path, markup] of Object.entries(buttons))
      await t.test(`${path} at ${width}`, async () => {
        const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch });
        t.after(() => page.close());
        await page.route("https://**", (route) => route.abort());
        await page.goto(server.origin + path);
        await page.waitForLoadState("networkidle");
        const gaps = await page.evaluate((markup) => {
          const host = document.createElement("div");
          host.style.width = "200px";
          host.innerHTML = markup.join("");
          document.querySelector("main")?.prepend(host);
          return [...host.querySelectorAll(".btn, button")].map((button) => {
            const box = button.getBoundingClientRect();
            const border = Number.parseFloat(getComputedStyle(button).borderTopWidth);
            const range = document.createRange();
            range.selectNodeContents(button);
            const lines = [...range.getClientRects()];
            return {
              lines: new Set(lines.map((line) => Math.round(line.top))).size,
              top: Math.min(...lines.map((line) => line.top)) - box.top - border,
              bottom: box.bottom - Math.max(...lines.map((line) => line.bottom)) - border,
            };
          });
        }, markup);
        for (const gap of gaps) {
          assert.ok(gap.lines > 1, "the label wraps");
          assert.ok(gap.top >= 3.5 && gap.bottom >= 3.5, `text stays off the border: ${JSON.stringify(gap)}`);
        }
      });
});

test("every left-menu label fits inside its item", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());

  for (const { width, touch } of [
    { width: 1280, touch: false },
    { width: 1440, touch: false },
    { width: 390, touch: true },
  ])
    await t.test(`at ${width} with ${touch ? "touch" : "a mouse"}`, async () => {
      const page = await browser.newPage({ viewport: { width, height: 800 }, hasTouch: touch });
      t.after(() => page.close());
      await page.route("https://**", (route) => route.abort());
      await page.goto(`${server.origin}/?mode=fixture`);
      await page.waitForLoadState("networkidle");
      const items = await page.locator(".app-shell-navigation > a, .app-shell-more-toggle").evaluateAll((nodes) =>
        nodes.map((node) => ({
          label: node.textContent?.trim(),
          scroll: node.scrollWidth,
          client: node.clientWidth,
        })),
      );
      assert.ok(items.length >= 5, "the menu shows its items");
      assert.deepEqual(
        items.filter((item) => item.scroll > item.client),
        [],
      );
    });
});
