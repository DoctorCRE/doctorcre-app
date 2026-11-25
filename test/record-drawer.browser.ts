import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test from "node:test";
import { chromium } from "./browser-harness.mjs";
import { ownedServer as startFixtureServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/record-drawer";
await mkdir(shots, { recursive: true });
const recordId = "00000000-0000-4000-8000-000000000001";
const longName =
  "Demo Partner With A Very Long Practice Name That Runs Well Past The Edge Of The Header On Every Screen Size";

type Fixture = { record?: { name: string; people?: { contact: object }[] } };

/** A full record: a long name and every contact reachable, the way a busy record reads. */
function heavy(url: string) {
  // The fixture is untyped JavaScript; this names the fields the test fills in.
  const body = directoryFixture(url) as Fixture;
  if (!body.record) return body;
  body.record.name = longName;
  for (const person of body.record.people ?? [])
    Object.assign(person.contact, { email: "demo.contact@example.test", phone: "+15555550100", cell: "+15555550101" });
  return body;
}

for (const dataset of ["clients", "vendors"] as const)
  for (const [width, height] of [
    [1280, 640],
    [1440, 900],
    [390, 844],
  ] as const)
    test(`the ${dataset} drawer keeps one header row, body-size text and compact controls at ${width}`, async (t) => {
      const phone = width < 768;
      const server = await startFixtureServer();
      t.after(() => server.stop());
      const browser = await chromium.launch();
      t.after(() => browser.close());
      const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
      await page.route("https://**", (r) => r.abort());
      await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: heavy(r.request().url()) }));
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
      await panel.locator("#recordActions button", { hasText: "Edit" }).waitFor({ state: "attached" });
      if (dataset === "clients") await panel.locator("#recordActivity [data-retry='activity']").waitFor();
      await page.screenshot({ path: `${shots}/${dataset}-${width}.png` });

      const drawer = await panel.evaluate((node) => {
        const box = (el: Element | null) => el?.getBoundingClientRect() ?? new DOMRect();
        const head = node.querySelector(".record-panel-head");
        const title = node.querySelector<HTMLElement>("#recordTitle");
        const shown = [
          ...node.querySelectorAll(".record-panel-head button, #recordBody button, #recordBody summary"),
        ].filter((el) => el.getClientRects().length > 0);
        const style = (selector: string) => {
          const el = node.querySelector(selector);
          return el ? getComputedStyle(el) : null;
        };
        const fields = [...node.querySelectorAll(".detail-columns .record-field")].map(
          (field) => box(field.querySelector("dd")).left - box(field.querySelector("dt")).left,
        );
        return {
          headHeight: box(head).height,
          outsideHead: shown
            .filter((el) => head?.contains(el))
            .filter((el) => box(el).top < box(head).top || box(el).bottom > box(head).bottom)
            .map((el) => el.textContent),
          titleCut: (title?.scrollWidth ?? 0) > (title?.clientWidth ?? 0),
          titleTip: title?.title,
          controls: shown.map((el) => ({
            name: el.getAttribute("aria-label") ?? el.textContent?.trim(),
            height: box(el).height,
          })),
          valueSize: style(".record-field dd")?.fontSize,
          figureSize: style(".relationship-metric strong")?.fontSize ?? null,
          tinted: [".vendor-contacts > li", ".relationship-metrics", ".relationship-metric + .relationship-metric"]
            .map((selector) => [selector, style(selector)] as const)
            .filter(([, css]) => css && (css.backgroundColor !== "rgba(0, 0, 0, 0)" || css.borderLeftStyle !== "none"))
            .map(([selector]) => selector),
          sideways: node.scrollWidth > node.clientWidth,
          scrolls: node.scrollHeight > node.clientHeight,
          widestLabelGap: Math.max(...fields),
          body: node.querySelector("#recordBody")?.textContent ?? "",
        };
      });

      assert.ok(drawer.headHeight <= (phone ? 56 : 48), `the header is one bar: ${drawer.headHeight}px`);
      assert.deepEqual(drawer.outsideHead, [], "every header control sits in the one row");
      assert.ok(drawer.titleCut, "a long name is cut to one line");
      assert.equal(drawer.titleTip, longName, "the full name shows on hover");
      assert.equal(drawer.valueSize, phone ? "16px" : "14px", "values read at body size");
      if (dataset === "vendors") {
        assert.equal(drawer.figureSize, phone ? "16px" : "14px", "figures are body size");
        assert.deepEqual(drawer.tinted, [], "contacts and figures sit on the drawer, not in boxes");
      }
      assert.doesNotMatch(drawer.body, /Edit|Link to someone/, "the body does not repeat the actions");
      assert.equal(drawer.sideways, false, "nothing in the drawer scrolls sideways");

      if (phone) {
        await panel.getByRole("button", { name: "Record actions" }).click();
        const menu = await panel
          .locator("#recordActions button")
          .evaluateAll((buttons) => buttons.map((button) => button.getBoundingClientRect().height));
        await page.screenshot({ path: `${shots}/${dataset}-${width}-menu.png` });
        drawer.controls.push(...menu.map((menuHeight) => ({ name: "menu item", height: menuHeight })));
        for (const control of drawer.controls)
          assert.ok(control.height >= 44, `${control.name} is a 44px touch target: ${control.height}px`);
      } else {
        for (const control of drawer.controls)
          assert.ok(control.height >= 28 && control.height <= 32, `${control.name} is 28 to 32px: ${control.height}px`);
        assert.ok(drawer.widestLabelGap <= 190, `each value sits beside its label: ${drawer.widestLabelGap}`);
        if (dataset === "clients") assert.equal(drawer.scrolls, false, "the client drawer fits one screen");
      }
    });
