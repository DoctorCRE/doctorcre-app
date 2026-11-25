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

test("Documents takes a file by keyboard, click or drop and names it", async (t) => {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { APP_ENV: "fixture", CARR: { fetch: async () => new Response("synthetic") } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  await mkdir(shots, { recursive: true });

  const themes: ("light" | "dark")[] = ["light", "dark"];
  for (const viewport of [
    { width: 390, height: 844 },
    { width: 1280, height: 800 },
    { width: 1440, height: 900 },
  ])
    for (const theme of themes)
      await t.test(`${viewport.width} ${theme}`, async () => {
        const { width } = viewport;
        const page = await browser.newPage({ viewport, colorScheme: theme });
        t.after(() => page.close());
        await page.goto(`${server.origin}/deals?mode=fixture`);
        await page.evaluate(async (theme) => {
          document.documentElement.dataset.theme = theme;
          const main = document.createElement("main");
          main.className = "deal-workspace";
          document.body.replaceChildren(main);
          const sent: string[] = [];
          Object.assign(window, { sent });
          const path = "/js/ui-deal-documents.generated.js";
          const { mountDealDocumentUpload } = await import(path);
          mountDealDocumentUpload(main, {
            dealId: "00000000-0000-4000-8000-000000000001",
            documents: [],
            request: async (path: string) => {
              sent.push(path);
              return new Response(null, { status: 500 });
            },
            refreshDocuments: async () => [],
          });
        }, theme);
        const zone = page.locator(".deal-file-drop");
        await zone.getByText("Drop a file here or choose one").waitFor();
        const input = page.locator('input[type="file"]');
        assert.equal(
          await input.evaluate((input) => getComputedStyle(input).clip),
          "rect(0px, 0px, 0px, 0px)",
          "the browser's own file field is not shown",
        );

        await page.keyboard.press("Tab");
        assert.equal(await input.evaluate((input) => input === document.activeElement), true, "Tab reaches the picker");
        assert.notEqual(await zone.evaluate((zone) => getComputedStyle(zone).outlineStyle), "none", "focus shows");

        await input.setInputFiles({
          name: "Example lease.pdf",
          mimeType: "application/pdf",
          buffer: Buffer.from("%PDF"),
        });
        await zone.getByText("Example lease.pdf").waitFor();
        await page.screenshot({ path: `${shots}/documents-upload-${width}-${theme}.png` });

        await zone.evaluate((zone) => {
          const files = new DataTransfer();
          files.items.add(new File(["%PDF"], "Example counter.pdf", { type: "application/pdf" }));
          for (const type of ["dragover", "drop"])
            zone.dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: files }));
        });
        await zone.getByText("Example counter.pdf").waitFor();
        await page.getByLabel("Document type").selectOption("counter");
        await page.getByRole("button", { name: "Upload to this deal" }).click();
        await page.getByText("Could not confirm the upload. Try again.").waitFor();
        const sent: unknown = await page.evaluate(() => Reflect.get(window, "sent"));
        assert.ok(Array.isArray(sent));
        assert.match(
          sent[0] ?? "",
          /^\/api\/engine\/files\/[0-9a-f]{64}$/,
          "the dropped file goes through the same upload",
        );
      });
});
