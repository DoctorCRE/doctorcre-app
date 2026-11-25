import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Page } from "playwright";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import { chromium } from "./browser-harness.mjs";
import { ownedServer } from "./fixture-probe.ts";

const shots = "out/test-artifacts/relationships-first-screen";
await mkdir(shots, { recursive: true });

// The engine sorts by name, so notes in brackets, numbers and codes lead the list.
function crowdedNetwork(now: string, more: number) {
  const network = relationshipNetworkFixture(now);
  const [template] = network.nodes;
  if (!template) throw Error("the fixture has no nodes");
  const node = (id: string, name: string, kind: string, ref?: string) => ({
    ...template,
    id,
    record_id: id,
    name,
    kind,
    territory: "",
    verticals: [],
    ...(ref ? { ref } : {}),
  });
  const placeholders = [
    node("party:demo-note", "(new practice, moving north)", "contact"),
    node("party:demo-via", "(via referral)", "lead"),
    node("party:demo-site", "demo-site.com", "contact"),
    node("party:demo-digits", "4410", "client"),
    node("party:demo-code", "V-CPA-901", "vendor"),
  ];
  const many = Array.from({ length: more }, (_, i) =>
    node(`party:demo-many-${i}`, `Demo Practice ${String(i).padStart(3, "0")}`, "contact"),
  );
  network.nodes = [
    ...placeholders,
    ...network.nodes,
    node("party:demo-coded", "Demo Coded Dental", "client", "C-042"),
    node("party:demo-tagged", "Demo Tagged Dental (C-913)", "client", "C-913"),
    ...many,
  ];
  const [offer] = network.suggestions;
  if (offer) offer.reason = "Met C-042 and L-777 at the demo meetup.";
  return network;
}

async function openRelationships(t: TestContext, width: number, height: number, more = 240) {
  const server = await ownedServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  t.after(() => assert.deepEqual(errors, [], "the page raised no errors"));
  await page.route("https://**", (route) => route.abort());
  await page.route("**/api/v1/business/relationships**", async (route) =>
    route.fulfill({ json: crowdedNetwork(await page.evaluate(() => new Date().toISOString()), more) }),
  );
  await page.route(/\/(api\/system-work\/session|auth\/session)$/, (route) =>
    route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } }),
  );
  await page.route("**/mcp", (route) => {
    const request = route.request().postDataJSON();
    return route.fulfill({
      json: { jsonrpc: "2.0", id: request.id, result: { content: [{ type: "text", text: "{}" }] } },
    });
  });
  await page.goto(`${server.url}/relationships?mode=live`);
  await page.locator("#networkNodes [data-node]").first().waitFor();
  return page;
}

const firstScreen = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
    const list = document.getElementById("networkNodes");
    return {
      pageScrolls: document.documentElement.scrollHeight > innerHeight,
      sideways: document.documentElement.scrollWidth > innerWidth,
      graphTop: Math.round(box(".relationship-graph-panel").top),
      graphBottom: Math.round(box(".relationship-graph-panel").bottom),
      listBottom: Math.round(box("#networkNodes").bottom),
      listScrolls: Boolean(list && list.scrollHeight > list.clientHeight),
    };
  });

const clippedSelects = (page: Page) =>
  page.evaluate(() => {
    const ruler = document.createElement("canvas").getContext("2d");
    if (!ruler) throw Error("no canvas");
    return [...document.querySelectorAll<HTMLSelectElement>("#networkFilters select")].flatMap((select) => {
      const style = getComputedStyle(select);
      ruler.font = style.font;
      const text = select.selectedOptions[0]?.text ?? "";
      const room = select.clientWidth - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight) - 16;
      return ruler.measureText(text).width > room ? [text] : [];
    });
  });

for (const [width, height] of [
  [1280, 640],
  [1440, 900],
] as const)
  test(`Relationships fits one screen at ${width}x${height} and the directory scrolls inside itself`, async (t) => {
    const page = await openRelationships(t, width, height);
    await page.screenshot({ path: `${shots}/relationships-${width}.png` });
    const fit = await firstScreen(page);
    assert.equal(fit.pageScrolls, false, "the page itself does not scroll");
    assert.equal(fit.sideways, false, "nothing scrolls sideways");
    assert.ok(fit.graphTop <= 112, `the network starts near the top, not at ${fit.graphTop}px`);
    assert.ok(fit.graphBottom <= height, `the network ends on screen, not at ${fit.graphBottom}px`);
    assert.ok(fit.listBottom <= height, `the directory ends on screen, not at ${fit.listBottom}px`);
    assert.ok(fit.listScrolls, "the directory scrolls inside itself");
    assert.deepEqual(await clippedSelects(page), [], "every filter shows its whole choice");
    const first = page.locator("#networkNodes [data-node]").first();
    const before = await first.boundingBox();
    await first.hover();
    await page.mouse.wheel(0, 400);
    await page.waitForFunction(
      (top) => (document.querySelector("#networkNodes [data-node]")?.getBoundingClientRect().top ?? top) < top - 100,
      before?.y ?? 0,
    );
    assert.equal(
      await page.evaluate(() => document.getElementById("appMainSlot")?.scrollTop),
      0,
      "only the directory moved",
    );
  });

test("placeholder names do not lead and never read as people or companies", async (t) => {
  const page = await openRelationships(t, 1440, 900, 0);
  const names = await page.locator("#networkNodes [data-node] strong").allTextContents();
  assert.equal(names.length, 15, "every record still shows");
  assert.equal(names[0], "Demo Healthcare Lending", "a named record leads the directory");
  assert.deepEqual(
    names.slice(-5),
    [
      "Unnamed contact (new practice, moving north)",
      "Unnamed lead (via referral)",
      "Unnamed contact (demo-site.com)",
      "Unnamed client (4410)",
      "An old record",
    ],
    "placeholders follow the named records and say what they are",
  );
  const intros = await page.locator("#networkIntroductions").textContent();
  assert.match(intros ?? "", /Met Demo Coded Dental and an old record at the demo meetup\./);
  const shown = await page.locator("#main").textContent();
  assert.doesNotMatch(shown ?? "", /V-CPA-901|C-042|C-913|L-777/, "no old record code shows");
  await page.locator('#networkNodes [data-node="party:demo-tagged"]').click();
  assert.equal(
    await page.locator("#relationshipTitle").textContent(),
    "Demo Tagged Dental",
    "the card names the record as the directory does",
  );
});

test("Relationships stays usable on a phone", async (t) => {
  const page = await openRelationships(t, 390, 844);
  await page.screenshot({ path: `${shots}/relationships-390.png` });
  assert.equal((await firstScreen(page)).sideways, false, "nothing scrolls sideways");
  const first = await page.locator("#networkNodes [data-node]").first().boundingBox();
  assert.ok(first && first.y <= 300, `the directory starts on the first screen, at ${first?.y}px`);
  const rows = page.locator("#networkNodes [data-node]");
  assert.equal(await rows.count(), 50, "the phone shows the directory a page at a time");
  await page.getByRole("button", { name: "Show more" }).click();
  assert.equal(await rows.count(), 100, "Show more adds the next page");
  assert.equal(await page.locator("#networkCount").textContent(), "255", "the count still covers every record");
});

test("the keyboard carries on from the first row Show more adds", async (t) => {
  const page = await openRelationships(t, 1440, 900, 60);
  const more = page.locator("#networkMoreNodes");
  await more.focus();
  await page.keyboard.press("Enter");
  assert.equal(await more.isHidden(), true, "the last page hides Show more");
  const focused = () =>
    page.evaluate(() =>
      [...document.querySelectorAll("#networkNodes > [data-node]")].findIndex((row) => row === document.activeElement),
    );
  assert.equal(await focused(), 50, "focus lands on the first new row");
  await page.keyboard.press("Tab");
  assert.equal(await focused(), 51, "Tab moves on to the next row");
});
