import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import { chromium } from "./browser-harness.mjs";

const shots = "out/test-artifacts/deal-page-fit";

test("a deal page header is compact and every tab fits on laptops", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(shots, { recursive: true });

  for (const [width, height] of [
    [390, 844],
    [1200, 800],
    [1280, 800],
    [1440, 900],
  ] as const)
    for (const theme of ["light", "dark"] as const)
      await t.test(`${width} ${theme}`, async (t) => {
        const context = await browser.newContext({ viewport: { width, height }, colorScheme: theme });
        t.after(() => context.close());
        await context.addInitScript((theme) => localStorage.setItem("dealroom-theme", theme), theme);
        const page = await context.newPage();
        await page.goto(`${server.origin}/deals?mode=fixture&deal=d14`);
        assert.equal(await page.locator("html").getAttribute("data-theme"), theme);
        await page.locator("#panelTitle").filter({ hasText: "Demo Surgical Practice" }).waitFor();
        // The fixture hides engine-only tabs; a signed-in partner sees all seven.
        await page.locator('#workspaceTabs [role="tab"]').evaluateAll((tabs) => {
          for (const tab of tabs) tab.removeAttribute("hidden");
        });
        await page.getByRole("tab", { name: "Client view" }).click();
        await page.screenshot({ path: `${shots}/deal-client-view-${width}-${theme}.png` });

        const strip = page.locator("#workspaceTabs");
        assert.equal(
          await strip.evaluate((strip) => strip.scrollWidth <= strip.clientWidth),
          true,
          "the tab row has no scroll bar",
        );
        const outside = await strip.evaluate((strip) => {
          const bounds = strip.getBoundingClientRect();
          return [...strip.querySelectorAll('[role="tab"]')]
            .filter((tab) => {
              const box = tab.getBoundingClientRect();
              return box.left < bounds.left - 1 || box.right > bounds.right + 1;
            })
            .map((tab) => tab.textContent);
        });
        assert.deepEqual(outside, [], "every tab shows whole");
        const [title, header] = await Promise.all([
          page.locator("#panelTitle").boundingBox(),
          page.locator(".workspace-header").boundingBox(),
        ]);
        assert.ok(title && header && title.x >= header.x + 8, "the deal name sits clear of the header's edge");
        if (width < 651) return;

        const back = await page.getByRole("button", { name: "Back to deals" }).boundingBox();
        assert.ok(back && back.y + back.height > title.y, "Back to deals and the deal name share one row");
      });
});

test("Documents offers a file button styled like the app's buttons", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(shots, { recursive: true });

  for (const theme of ["light", "dark"] as const) {
    const page = await browser.newPage({ viewport: { width: 1200, height: 800 }, colorScheme: theme });
    t.after(() => page.close());
    await page.goto(`${server.origin}/deals?mode=fixture`);
    await page.evaluate(async (theme) => {
      document.documentElement.dataset.theme = theme;
      const main = document.createElement("main");
      main.className = "deal-workspace";
      document.body.replaceChildren(main);
      const path = "/js/ui-deal-documents.generated.js";
      const { mountDealDocumentUpload } = await import(path);
      mountDealDocumentUpload(main, {
        dealId: "00000000-0000-4000-8000-000000000001",
        documents: [],
        request: async () => new Response(null, { status: 500 }),
        refreshDocuments: async () => [],
      });
      const reference = document.createElement("button");
      reference.className = "btn";
      reference.id = "reference";
      reference.textContent = "Reference";
      document.body.append(reference);
    }, theme);
    const input = page.locator('input[type="file"]');
    await input.waitFor();
    await page.screenshot({ path: `${shots}/documents-upload-${theme}.png` });
    const looks = await page.evaluate(() => {
      const pick = (style: CSSStyleDeclaration) => ({
        background: style.backgroundColor,
        border: `${style.borderTopWidth} ${style.borderTopStyle} ${style.borderTopColor}`,
        radius: style.borderTopLeftRadius,
        color: style.color,
        weight: style.fontWeight,
        size: style.fontSize,
      });
      const input = document.querySelector('input[type="file"]');
      const reference = document.querySelector("#reference");
      if (!input || !reference) throw Error("upload form not shown");
      return {
        file: pick(getComputedStyle(input, "::file-selector-button")),
        button: pick(getComputedStyle(reference)),
        boxed: getComputedStyle(input).borderTopStyle !== "none",
      };
    });
    assert.deepEqual(looks.file, looks.button, "the file button matches the app's buttons");
    assert.equal(looks.boxed, false, "the file field has no box of its own");
  }
});
