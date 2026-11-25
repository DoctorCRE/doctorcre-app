import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/record-drawer";
await mkdir(shots, { recursive: true });
const recordId = "00000000-0000-4000-8000-000000000001";

for (const dataset of ["clients", "vendors"] as const)
  for (const [width, height] of [
    [1280, 800],
    [1440, 900],
    [390, 844],
  ] as const)
    test(`the ${dataset} drawer keeps its actions in the header and values beside labels at ${width}`, async (t) => {
      const server = await startFixtureServer();
      t.after(() => server.stop());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      await page.route("https://**", (r) => r.abort());
      await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: directoryFixture(r.request().url()) }));
      await page.route("**/auth/session", (r) =>
        r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
      );
      // The record actions show once the Clients and Vendors switch reads from the engine.
      await page.route(
        (url) => url.pathname === `/${dataset}`,
        async (route) => {
          const response = await route.fetch();
          const body = (await response.text()).replace("<html ", "<html data-clients-vendors-from-engine ");
          return route.fulfill({ response, body });
        },
      );
      await page.goto(`${server.url}/${dataset}?record=${recordId}&mode=live`);
      const panel = page.locator("#recordPanel");
      await panel.getByRole("button", { name: "Edit" }).waitFor();
      await page.screenshot({ path: `${shots}/${dataset}-${width}.png` });
      const drawer = await panel.evaluate((node) => {
        const head = node.querySelector(".record-panel-head");
        const left = (cell: Element | null) => cell?.getBoundingClientRect().left ?? 0;
        const fields = [...node.querySelectorAll(".detail-columns .record-field")].map(
          (field) => left(field.querySelector("dd")) - left(field.querySelector("dt")),
        );
        return {
          actionsInHead: [...node.querySelectorAll("button")]
            .filter((button) => ["Edit", "Link to someone"].includes(button.textContent?.trim() ?? ""))
            .every((button) => head?.contains(button)),
          sideways: node.scrollWidth > node.clientWidth,
          widestLabelGap: Math.max(...fields),
          body: node.querySelector("#recordBody")?.textContent ?? "",
        };
      });
      assert.ok(drawer.actionsInHead, "Edit and Link to someone sit in the header");
      assert.doesNotMatch(drawer.body, /Edit|Link to someone/, "the body does not repeat the actions");
      assert.equal(drawer.sideways, false, "nothing in the drawer scrolls sideways");
      if (width > 767)
        assert.ok(drawer.widestLabelGap <= 190, `each value sits beside its label: ${drawer.widestLabelGap}`);
    });
