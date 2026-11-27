import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
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
    Object.assign(person.contact, {
      email: "demo.contact@example.test",
      phone: "+15555550100",
      cell: "+15555550101",
    });
  return body;
}

/** Opens a heavy record's drawer with the Clients and Vendors switch on. */
async function openDrawer(t: TestContext, dataset: "clients" | "vendors", width: number, height: number) {
  const server = await startFixtureServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    reducedMotion: "reduce",
  });
  await page.route("https://**", (r) => r.abort());
  await page.route("**/api/v1/business/**", (r) => r.fulfill({ json: heavy(r.request().url()) }));
  await page.route("**/auth/session", (r) => r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }));
  // The vendor card reads the stored relationship from the party.
  await page.route("**/api/engine/parties/*", (r) =>
    r.fulfill({
      json: {
        vendor: {
          relationship_level: 3,
          disposition: null,
          disposition_reason: null,
          is_target: false,
        },
      },
    }),
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
  await page.goto(`${server.url}/${dataset}?all=true&record=${recordId}&mode=live`);
  const panel = page.locator("#recordPanel");
  await panel.locator("#recordActions button", { hasText: "Edit" }).waitFor({ state: "attached" });
  if (dataset === "clients") await panel.locator("#recordActivity [data-retry='activity']").waitFor();
  return { page, panel };
}

for (const dataset of ["clients", "vendors"] as const)
  for (const [width, height] of [
    [1280, 640],
    [1440, 900],
    [390, 844],
  ] as const)
    test(`a ${dataset} card names the record in full beside the table, or over it with a back link on a phone, at ${width}`, async (t) => {
      const phone = width < 768;
      const vendor = dataset === "vendors";
      const { page, panel } = await openDrawer(t, dataset, width, height);
      if (vendor) await panel.locator(".rel-button:not([disabled])").waitFor();
      await page.screenshot({ path: `${shots}/${dataset}-card-${width}.png` });
      const card = await panel.evaluate((node) => {
        const box = (selector: string) => node.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
        const title = node.querySelector<HTMLElement>("#recordTitle");
        const style = (selector: string) => {
          const el = node.querySelector(selector);
          return el ? getComputedStyle(el) : null;
        };
        const shown = [
          ...node.querySelectorAll(".record-panel-head button, #recordBody button, #recordBody summary"),
        ].filter((el) => el.getClientRects().length > 0);
        return {
          width: node.getBoundingClientRect().width,
          figureSize: style(".relationship-metric strong")?.fontSize,
          valueSize: style(".record-field dd")?.fontSize,
          tinted: [".vendor-contacts > li", ".relationship-metrics", ".relationship-metric + .relationship-metric"]
            .map((selector) => [selector, style(selector)] as const)
            .filter(([, css]) => css && (css.backgroundColor !== "rgba(0, 0, 0, 0)" || css.borderLeftStyle !== "none"))
            .map(([selector]) => selector),
          titleCut: (title?.scrollWidth ?? 0) > (title?.clientWidth ?? 0),
          back: box(".panel-back").height,
          close: box(".panel-close").height,
          relationship: box(".rel-button").height,
          controls: shown.map((el) => ({
            name: el.getAttribute("aria-label") ?? el.textContent?.trim(),
            height: el.getBoundingClientRect().height,
          })),
          body: node.querySelector("#recordBody")?.textContent ?? "",
          sideways: node.scrollWidth > node.clientWidth,
        };
      });
      assert.equal(card.titleCut, false, "the whole name shows");
      assert.doesNotMatch(card.body, /Edit|Link to someone/, "the body does not repeat the actions");
      assert.equal(card.sideways, false, "nothing in the card scrolls sideways");
      if (vendor) {
        assert.equal(card.figureSize, card.valueSize, "figures read at body size");
        assert.deepEqual(card.tinted, [], "contacts and figures sit on the card, not in boxes");
      }
      if (phone) {
        assert.ok(card.width >= width - 1, `the card takes the screen: ${card.width}px`);
        assert.ok(card.back >= 44, `the back link is a 44px touch target: ${card.back}px`);
        assert.ok(card.close >= 44, `the x stays at the top: ${card.close}px`);
        await panel.locator(".panel-back").click();
        await panel.waitFor({ state: "hidden" });
      } else {
        assert.ok(card.width <= 420, `the card sits beside the table: ${card.width}px`);
        assert.equal(card.back, 0, "a computer closes the card with its close button");
        for (const control of card.controls)
          assert.ok(control.height >= 28 && control.height <= 32, `${control.name} is 28 to 32px: ${control.height}px`);
        if (vendor)
          assert.ok(
            card.relationship >= 28 && card.relationship <= 32,
            `the relationship button: ${card.relationship}px`,
          );
        const row = page.locator(".record-row").nth(1);
        const next = await row.getAttribute("data-record-id");
        await row.click();
        await page.waitForURL(new RegExp(`record=${next}`));
      }
    });

for (const dataset of ["clients", "vendors"] as const)
  test(`a ${dataset} row opens its card beside the table, highlighted, and Escape or the x returns to the row`, async (t) => {
    const { page, panel } = await openDrawer(t, dataset, 1280, 640);
    const row = page.locator(".record-row").nth(1);
    const rowId = await row.getAttribute("id");
    await row.click();
    await page.waitForURL(new RegExp(`record=${await row.getAttribute("data-record-id")}`));
    await panel.locator("#recordActions button", { hasText: "Edit" }).waitFor({ state: "attached" });
    const beside = await page.evaluate(() => {
      const open = document.querySelector(".record-row[aria-current='true']");
      const rowBox = open?.getBoundingClientRect() ?? new DOMRect();
      const cardBox = document.querySelector("#recordPanel")?.getBoundingClientRect() ?? new DOMRect();
      return {
        highlighted: open?.id,
        role: document.querySelector("#recordPanel")?.getAttribute("role"),
        backdrop: !document.querySelector<HTMLElement>("#recordBackdrop")?.hidden,
        rowClear: rowBox.width > 0 && rowBox.right <= cardBox.left,
      };
    });
    assert.equal(beside.highlighted, rowId, "the open row is highlighted");
    assert.equal(beside.role, "complementary", "the card is not a dialog on a computer");
    assert.equal(beside.backdrop, false, "nothing covers the table");
    assert.ok(beside.rowClear, "the open row shows whole beside the card");

    await page.keyboard.press("Escape");
    await panel.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), rowId, "Escape returns focus to the row");

    await row.click();
    await panel.locator("#recordActions button", { hasText: "Edit" }).waitFor({ state: "attached" });
    await panel.getByRole("button", { name: "Close record" }).click();
    await panel.waitFor({ state: "hidden" });
    assert.equal(await page.evaluate(() => document.activeElement?.id), rowId, "the x returns focus to the row");
  });

test("on a phone the record actions menu says whether it is open, and Escape closes only the menu", async (t) => {
  const { page, panel } = await openDrawer(t, "clients", 390, 844);
  const more = panel.getByRole("button", { name: "Record actions" });
  const menu = panel.locator("#recordActions");
  const expanded = (state: "true" | "false") =>
    page.waitForFunction(
      (want) => document.querySelector("#recordMore")?.getAttribute("aria-expanded") === want,
      state,
    );

  assert.equal(await more.getAttribute("aria-controls"), "recordActions", "the button names its menu");
  assert.equal(await more.getAttribute("aria-expanded"), "false", "closed at first");
  await more.click();
  await expanded("true");

  await page.keyboard.press("Escape");
  await expanded("false");
  assert.equal(await menu.evaluate((node) => node.matches(":popover-open")), false, "Escape closes the menu");
  assert.equal(await panel.isVisible(), true, "the record stays open");
  assert.equal(await page.evaluate(() => document.activeElement?.id), "recordMore", "focus returns to the menu button");

  await more.click();
  await expanded("true");
  await panel.locator("#recordBody").click({ position: { x: 8, y: 8 } });
  await expanded("false");

  await more.click();
  await expanded("true");
  await menu.getByRole("button", { name: "Edit" }).click();
  await expanded("false");
});

test("a second Escape after the menu closes leaves the record", async (t) => {
  const { page, panel } = await openDrawer(t, "clients", 390, 844);
  await panel.getByRole("button", { name: "Record actions" }).click();
  await page.keyboard.press("Escape");
  await page.keyboard.press("Escape");
  await panel.waitFor({ state: "hidden" });
});
