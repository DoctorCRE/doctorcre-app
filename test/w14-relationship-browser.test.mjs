import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdir } from "node:fs/promises";
import { setTimeout as delay } from "node:timers/promises";
import { componentDocument, animationsSettled, chromium, waitForAsync } from "./browser-harness.mjs";
import { isUiAsset, uiAssets } from "../scripts/ui-bundle.mjs";
import { relationshipNetworkFixture } from "../js/relationship-network-fixture.js";
import axe from "axe-core";
const root = new URL("../", import.meta.url);
const assets = await uiAssets(path => readFile(new URL(path, root)));
async function open(t, width = 1440) {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height: width === 390 ? 844 : 1000 },
  });
  await page.clock.install({ time: new Date() });
  const errors = [],
    verbs = [];
  let mode = "ok",
    version = 0;
  page.on("pageerror", (e) => errors.push(e.message));
  await page.route("**/*", async (r) => {
    const url = new URL(r.request().url());
    if (url.origin !== "http://localhost") return r.abort();
    if (url.pathname === "/api/v1/business/relationships") {
      if (mode === "auth")
        return r.fulfill({
          status: 401,
          json: { error: "AUTHENTICATION_REQUIRED" },
        });
      if (mode === "fail")
        return r.fulfill({
          status: 503,
          json: { error: "DEPENDENCY_UNAVAILABLE" },
        });
      const payload = relationshipNetworkFixture(
        await page.evaluate(() => new Date().toISOString()),
      );
      if (url.searchParams.get("step") === "11111111-1111-4111-8111-111111111111")
        payload.focused_step = { id: "11111111-1111-4111-8111-111111111111", party_id: "demo-build", what: "Demo next step", status: "open" };
      if (version) payload.nodes[0].summary = "Demo refreshed summary";
      if (mode === "malformed") payload.edges[0].from = "missing";
      if (mode === "territory") payload.nodes[0].territory = 123;
      if (mode === "labels") {
        payload.nodes[0].name = "Demo Healthcare Lending North Partners";
        payload.nodes[0].territory = "Demo Northern Coastal Territory";
        payload.nodes.find(n => n.kind === "deal").name = JSON.stringify({value:"Demo Dental Relocation"});
      }
      if (mode === "duplicate") payload.edges[0].detail = payload.edges[0].summary;
      if (mode === "connections" || mode === "reciprocal" || mode === "connection-ties") {
        const contact = { id: "party:demo-contact", name: "Demo Contact (TBD)", kind: "contact", verticals: [] };
        payload.nodes.push(contact, { ...contact, id: "party:demo-isolated", name: "Demo Isolated" });
        const tied = mode === "connection-ties";
        if (tied && version) contact.summary = "Demo contact refreshed";
        for (let i = 1; i <= (tied ? 22 : 45); i++) {
          if (tied) {
            const id = String(i).padStart(2, "0");
            const name = i === 22 ? "Demo Aardvark" : `Demo Link ${i === 21 ? "20" : id}`;
            payload.nodes.push({ ...contact, id: `party:demo-tied-${id}`, name });
            payload.edges.push({
              id: `link:demo-tied-${id}`,
              from: contact.id,
              to: `party:demo-tied-${id}`,
              kind: "knows",
              when: i === 22 ? null : i === 1 ? "2026-02-01" : "2026-01-01",
            });
            continue;
          }
          const other = { ...contact, id: `party:demo-linked-${i}`, name: `Demo Link ${i}` };
          payload.nodes.push(other);
          payload.edges.push({
            id: `link:demo-${i}`,
            from: i === 1 ? other.id : contact.id,
            to: i === 1 ? "party:demo-build" : other.id,
            via: i === 1 ? contact.id : null,
            kind: i === 1 ? "introduced" : "knows",
            when: i === 1 ? null : new Date(Date.UTC(2026, 0, i)).toISOString(),
          });
        }
      }
      if (mode === "reciprocal") {
        payload.edges.push(
          { id: "link:demo-reverse", from: "party:demo-linked-2", to: "party:demo-contact",
            kind: "works_with", when: "2026-02-02", summary: "Demo project notes" },
          { id: "link:demo-repeat", from: "party:demo-linked-2", to: "party:demo-contact",
            kind: "knows", when: "2026-01-01" },
        );
      }
      if (mode === "connection-ties" && version) payload.edges.reverse();
      if (mode === "records") payload.nodes.push({ id: "party:isolated-vendor", record_id: "vendor & 1", name: "Demo Isolated Vendor", kind: "vendor", verticals: [] }, { id: "party:demo-isolated", name: "Demo Isolated", kind: "contact", verticals: [] });
      if (mode === "connector") {
        payload.edges[0].via = "party:demo-build";
        payload.suggestions[0].via = "party:demo-build";
      }
      if (mode === "route-text") payload.nodes[0].name = "Demo <em>Lending</em> & Partners";
      if (mode === "twins") {
        payload.nodes[0].name = "Demo Healthcare Lending North Partners (V-SUP-901)";
        payload.nodes[3].name = "Demo Healthcare Lending South Partners";
      }
      return r.fulfill({ json: payload });
    }
    if (['/api/system-work/session','/auth/session'].includes(url.pathname))
      return r.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic-session" } });
    if (url.pathname === "/mcp") {
      const verb = r.request().postDataJSON().params.name;
      verbs.push(verb);
      let payload = { ok: true };
      if (verb === "read-home-agenda") payload = { schema_version: "home-agenda.v1", deals: [], actor: "joe" };
      if (verb === "deal-room-board") payload = { deals: [], actor: "joe" };
      if (verb === "deal-room-changes") payload = { events: [], cursor: null };
      return r.fulfill({
        json: {
          jsonrpc: "2.0",
          id: 1,
          result: {
            content: [{ type: "text", text: JSON.stringify(payload) }],
          },
        },
      });
    }
    if (url.pathname.startsWith("/api/")) return r.fulfill({ json: {} });
    const file =
      url.pathname === "/"
        ? "review-workflows.html"
        : url.pathname === "/relationships"
          ? "relationships.html"
          : url.pathname.slice(1);
    try {
      const body = isUiAsset(file) ? assets.get(file) : await readFile(new URL(file, root));
      if (!body) return r.fulfill({ status: 404, body: "" });
      return r.fulfill({
        body,
        contentType: /\.m?js$/.test(file)
          ? "text/javascript"
          : file.endsWith(".css")
            ? "text/css"
            : file.endsWith(".json")
              ? "application/json"
              : "text/html",
      });
    } catch {
      return r.fulfill({ status: 404, body: "" });
    }
  });
  await mkdir(new URL("out/test-artifacts/w14", root), { recursive: true });
  return {
    page,
    errors,
    verbs,
    setMode: (v) => {
      mode = v;
    },
    setVersion: (v) => {
      version = v;
    },
  };
}
async function dragLender(page) {
  // Let the shared harness finish layout motion and retry false samples.
  await animationsSettled(page);
  await waitForAsync(
    page,
    () =>
      new Promise((resolve) => {
        const read = () => {
          const r = document
            .querySelector('[data-node="party:demo-lender"]')
            .getBoundingClientRect();
          return `${document.querySelector("#networkScene").getAttribute("transform")} ${r.x} ${r.y} ${r.width} ${r.height}`;
        };
        const first = read();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve(read() === first)),
        );
      }),
  );
  const dragged = page.locator('[data-node="party:demo-lender"]').first();
  const box = await dragged.boundingBox();
  const x = box.x + box.width / 2, y = box.y + box.height / 2;
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x + 35, y + 25, { steps: 4 });
  await page.mouse.up();
}

for (const width of [1440, 390])
  test(`W14 graph, referrals and evidence popup at ${width}px`, async (t) => {
    const h = await open(t, width),
      { page } = h;
    await page.goto("http://localhost/relationships?mode=live");
    await page.waitForSelector("#appTabsSlot #graphTab");
    const title = await page.getByRole("heading", { level: 1, name: "Relationships" }).boundingBox();
    assert.ok(title.y < (await page.getByRole("tab", { name: "Network" }).boundingBox()).y, "Relationships title is above the Network tab");
    await page.waitForSelector(width === 390 ? "#networkNodes button" : ".relationship-node");
    assert.equal(await page.locator("#appLayout").count(), 1);
    assert.equal(await page.locator("#appTabsSlot #graphTab").count(), 1);
    assert.equal(
      await page.locator("#appSidebarSlot #networkSearch").count(),
      1,
    );
    assert.equal(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/network-${width}.png`,
      animations: "disabled",
    });
    await page.locator(width === 390 ? '#networkNodes [data-node="party:demo-lender"]' : '.relationship-node[data-node="party:demo-lender"]').focus();
    await page.keyboard.press("Enter");
    await page.waitForSelector(".relationship-dialog[open]");
    assert.match(
      await page.locator(".relationship-dialog").innerText(),
      /Deals sent|Can introduce/,
    );
    assert.ok(
      (await page.locator(".relationship-dialog").boundingBox()).width >
        width * 0.75,
    );
    await page
      .locator('.relationship-dialog details[data-entry="demo-offer"] summary')
      .click();
    assert.match(
      await page.locator(".relationship-dialog details[open]").innerText(),
      /Original synthetic email/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/detail-${width}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    assert.equal(await page.locator(".relationship-dialog").isVisible(), false);
    assert.equal(
      await page.evaluate(() => document.activeElement.getAttribute('data-node')),
      'party:demo-lender',
      'Dismissal restores the exact opening node',
    );
    await page.locator("#referralsTab").click();
    assert.equal(await page.locator(".relationship-referral").count(), 2);
    assert.match(
      await page.locator("#networkReferrals").innerText(),
      /100% win rate/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/referrals-${width}.png`,
      animations: "disabled",
    });
    await page.locator("#networkTerritory").selectOption("Demo Inland");
    assert.equal(await page.locator(".relationship-referral").count(), 0);
    await page.locator("#networkReset").click();
    assert.equal(await page.locator(".relationship-referral").count(), 2);
    assert.deepEqual(h.errors, []);
    assert.ok(
      h.verbs.every((v) =>
        [
          "deal-room-board",
          "morning-brief",
          "deal-room-changes",
          "unread-count",
          "list-feature-switches","list-doc-suggestions",
        ].includes(v),
      ),
    );
  });
for (const width of [1440, 320])
  test(`W14 graph nodes keep full record identity in their accessible names at ${width}px`, async (t) => {
    const h = await open(t, width),
      { page } = h;
    h.setMode("twins");
    await page.goto("http://localhost/relationships?mode=live");
    await page.waitForSelector(width === 320 ? "#networkNodes button" : ".relationship-node");
    const shown = await page.locator(".relationship-node").evaluateAll((nodes) =>
      nodes.map((node) => node.querySelector(".node-name").textContent));
    assert.equal(shown.filter((text) => text.startsWith("Demo Healthcare Lending")).length, 2, "both similar names remain present for accessible identification");
    for (const [side, connections] of [["North", 3], ["South", 2]]) {
      const name = width === 1440
        ? `Open Vendor, Demo Healthcare Lending ${side} Partners, Demo Coast`
        : `Demo Healthcare Lending ${side} Partners Vendor · Demo Coast · ${connections} connections`;
      assert.equal(await page.getByRole("button", { name, exact: true }).count(), 1);
    }
    const search = page.getByRole("searchbox", { name: "Find a relationship" });
    await search.fill("Demo Healthcare Lending North Partners (V-SUP-901)");
    assert.equal(await page.locator('.relationship-node').count(), 1);
    assert.doesNotMatch(await page.locator('#networkCanvas').textContent(), /V-SUP-901/);
    await search.fill("");
    await page.addScriptTag({ content: axe.source });
    const audit = await page.evaluate(() => window.axe.run(document.querySelector(innerWidth < 760 ? "#networkNodes" : "#networkCanvas"), { runOnly: ["label-content-name-mismatch"] }));
    assert.deepEqual(audit.violations, []);
    assert.deepEqual(audit.incomplete, []);
    const passed = (audit.passes[0]?.nodes || []).map((node) => node.html);
    if (width === 1440) for (const id of ["party:demo-lender", "party:demo-build"])
      assert.ok(passed.some((html) => html.includes(`data-node="${id}"`)), `${id} shows a label contained in its name`);
    assert.deepEqual(h.errors, []);
  });

test("W14 autonomous refresh retains filters and expanded evidence, recovers failure and clears auth", async (t) => {
  const h = await open(t),
    { page } = h;
  await page.goto("http://localhost/relationships?mode=live");
  await page.waitForSelector(".relationship-node");
  await page.locator("#networkSearch").fill("Lending");
  assert.equal(await page.locator("#networkNodes button").count(), 1);
  await page.locator("#networkNodes button").click();
  await page.locator(".relationship-dialog summary").first().click();
  h.setVersion(1);
  await page.clock.fastForward(61000);
  await page.waitForFunction(() =>
    document
      .querySelector(".relationship-dialog")
      .textContent.includes("Demo refreshed summary"),
  );
  assert.equal(
    await page
      .locator(".relationship-dialog details")
      .first()
      .getAttribute("open"),
    "",
  );
  assert.equal(await page.locator("#networkSearch").inputValue(), "Lending");
  h.setMode("fail");
  await page.clock.fastForward(121000);
  await page.waitForFunction(() =>
    document
      .querySelector("#networkNotice")
      .textContent.includes("unavailable"),
  );
  assert.equal(await page.locator(".relationship-node").count(), 0);
  assert.equal(await page.locator(".relationship-dialog").isVisible(), false);
  h.setMode("ok");
  await page.clock.fastForward(61000);
  await page.waitForSelector(".relationship-node");
  assert.equal(await page.locator("#networkSearch").inputValue(), "Lending");
  h.setMode("auth");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForURL("**/public-shell/session-ended.html");
  assert.equal(await page.locator(".relationship-node").count(), 0);
  assert.deepEqual(h.errors, []);
});
test("W14 malformed data, zoom fit and measured reduced motion", async (t) => {
  const h = await open(t),
    { page } = h;
  h.setMode("malformed");
  await page.goto("http://localhost/relationships?mode=live");
  await page.waitForFunction(() =>
    document
      .querySelector("#networkNotice")
      .textContent.includes("unavailable"),
  );
  assert.equal(await page.locator(".relationship-node").count(), 0);
  h.setMode("ok");
  await page.evaluate(() => window.dispatchEvent(new Event("online")));
  await page.waitForSelector(".relationship-node");
  await page.locator("#networkZoomIn").click();
  assert.match(
    await page.locator("#networkScene").getAttribute("transform"),
    /scale\(1.2\)/,
  );
  await page.locator("#networkFit").click();
  assert.match(
    await page.locator("#networkScene").getAttribute("transform"),
    /scale\(1\)/,
  );
  const dragged = page.locator('[data-node="party:demo-lender"]').first();
  const before = await dragged.getAttribute('transform');
  await dragLender(page);
  assert.notEqual(await dragged.getAttribute('transform'), before);
  assert.equal(await page.locator('.relationship-dialog').isVisible(), false);
  // V2: the network carries no ambient animation, with or without reduced motion.
  const animated = () => page.locator(".relationship-canvas").evaluate((root) => [...root.querySelectorAll("*")].filter((n) => getComputedStyle(n).animationName !== "none").length);
  assert.equal(await animated(), 0);
  await page.emulateMedia({ reducedMotion: "reduce" });
  assert.equal(await animated(), 0);
  assert.equal(
    await page
      .locator(".relationship-node rect")
      .first()
      .evaluate((n) => getComputedStyle(n).transitionDuration),
    "0s",
  );
  assert.equal(await page.locator(".relationship-node").count(), 8);
  assert.deepEqual(h.errors, []);
});
for (const width of [1440, 390])
  test(`W14 Home shares reason and opens card at ${width}px`, async (t) => {
    const h = await open(t, width),
      { page } = h;
    await page.goto("http://localhost/?mode=live");
    await page.waitForSelector("#homeIntroductions [data-intro-node]");
    assert.match(
      await page.locator("#homeIntroductions").innerText(),
      /Worked together on equipment financing/,
    );
    await page.locator("#homeIntroductions button").click();
    assert.match(
      await page.locator("#relationshipTitle").innerText(),
      /Demo Dental Expansion/,
    );
    await page.screenshot({
      path: `out/test-artifacts/w14/home-introduction-${width}.png`,
      animations: "disabled",
    });
    await page.keyboard.press("Escape");
    h.setMode("fail");
    await page.clock.runFor(61000);
    await page.waitForFunction(() => document.querySelector('#homeIntroductions').hidden);
    assert.equal(await page.locator('.relationship-dialog').isVisible(), false);
    h.setMode("ok");
    await page.evaluate(() => window.dispatchEvent(new Event('online')));
    await page.waitForSelector('#homeIntroductions [data-intro-node]');
    assert.deepEqual(h.errors, []);
  });

test('R2 relationship URL filters survive boot and intentional reset survives polling and reload',async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live&territory=Demo+Coast&vertical=dental');await page.waitForSelector('.relationship-node');
 assert.equal(new URL(page.url()).searchParams.get('territory'),'Demo Coast');assert.equal(new URL(page.url()).searchParams.get('vertical'),'dental');
 assert.equal(await page.locator('#networkTerritory').inputValue(),'Demo Coast');const polled=page.waitForResponse('**/api/v1/business/relationships*');await page.locator('#networkReset').click();await page.clock.fastForward(61000);
 await polled;await page.waitForFunction(()=>document.querySelector('#networkRefresh').getAttribute('aria-busy')==='false');
 assert.equal(await page.locator('#networkTerritory').inputValue(),'');assert.equal(await page.locator('#networkVertical').inputValue(),'');assert.equal(new URL(page.url()).searchParams.has('territory'),false);
 await page.reload();await page.waitForSelector('.relationship-node');assert.equal(await page.locator('#networkTerritory').inputValue(),'');assert.equal(await page.locator('.relationship-node').count(),8);assert.deepEqual(h.errors,[]);
});
for(const failure of ['auth','expiry']) test(`R6 ${failure} invalidates relationship detail DOM facets counts and controls`,async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live');await page.waitForSelector('.relationship-node');await page.locator('.relationship-node').first().click();
 h.setMode(failure==='auth'?'auth':'fail');await page.clock.fastForward(121000);
 if(failure==='auth'){await page.waitForURL('**/public-shell/session-ended.html');assert.equal(await page.locator('.relationship-dialog,#networkCanvas,#networkTerritory').count(),0);assert.deepEqual(h.errors,[]);return;}
 await page.waitForFunction(()=>document.querySelector('#networkNotice').textContent.includes('Sign in')||document.querySelector('#networkNotice').textContent.includes('unavailable'));
 assert.equal(await page.locator('.relationship-dialog').textContent(),'');assert.equal(await page.locator('#networkTerritory option').count(),1);assert.equal(await page.locator('#networkVertical option').count(),1);
 assert.equal(await page.locator('#networkCount').textContent(),'');assert.equal(await page.locator('#networkMore').isVisible(),false);assert.equal(await page.locator('#networkZoomIn').isDisabled(),true);assert.deepEqual(h.errors,[]);
});
test("Directory counts match a contact's links even when the other records are filtered out", async (t) => {
  const h = await open(t), { page } = h;
  h.setMode("connections");
  await page.goto("http://localhost/relationships?mode=live&q=Demo+Contact");
  const contact = page.locator("#networkNodes").getByRole("button", { name: /Demo Contact \(TBD\)/ });
  await contact.waitFor();
  assert.match(await contact.innerText(), /45 connections/);
  await contact.click();
  const dialog = page.getByRole("dialog");
  assert.match(await dialog.getByRole("heading", { name: /Connections/ }).innerText(), /45/);
  await dialog.getByRole("button", { name: "Show more", exact: true }).click();
  await dialog.getByRole("button", { name: "Show more", exact: true }).click();
  assert.equal(await dialog.locator(".relationship-entry").count(), 45);
  assert.match(await dialog.innerText(), /Introduced · via Demo Contact \(TBD\)/);
  await page.keyboard.press("Escape");
  await page.locator("#networkSearch").fill("Demo Isolated");
  const isolated = page.locator("#networkNodes").getByRole("button", { name: /Demo Isolated/ });
  assert.match(await isolated.innerText(), /0 connections/);
  await isolated.click();
  assert.equal(await dialog.getByText("No connections recorded", { exact: true }).count(), 1);
});

test("A contact's connections show newest first in batches", async (t) => {
  const h = await open(t, 390), { page } = h;
  h.setMode("connections");
  await page.goto("http://localhost/relationships?mode=live&q=Demo+Contact");
  await page.locator("#networkNodes").getByRole("button", { name: /Demo Contact/ }).click();
  const dialog = page.getByRole("dialog");
  const entries = dialog.locator(".relationship-entry");
  const more = dialog.getByRole("button", { name: "Show more", exact: true });
  assert.equal(await entries.count(), 20);
  assert.match(await entries.first().innerText(), /Demo Link 45/);
  assert.match(await entries.last().innerText(), /Demo Link 26/);
  await more.click();
  assert.equal(await entries.count(), 40);
  await more.click();
  assert.equal(await entries.count(), 45);
  assert.match(await entries.last().innerText(), /Demo Link 1\b/);
  assert.equal(await more.count(), 0);
});

test("Reciprocal links show one connection with every label and the latest date", async (t) => {
  const { page, setMode } = await open(t);
  setMode("reciprocal");
  await page.goto("http://localhost/relationships?mode=live&q=Demo+Contact");
  const contact = page.locator("#networkNodes").getByRole("button", { name: /Demo Contact/ });
  await contact.waitFor();
  assert.match(await contact.innerText(), /45 connections/);
  await contact.click();
  const dialog = page.getByRole("dialog");
  assert.equal(await dialog.getByRole("heading", { name: "Connections 45", exact: true }).count(), 1);
  const link = page.getByRole("button", { name: "Demo Link 2", exact: true });
  const entry = dialog.locator(".relationship-entry").filter({ has: link });
  assert.equal(await entry.count(), 1);
  assert.deepEqual((await entry.locator(":scope > span").innerText()).split(" · ").sort(), ["Knows", "Works with"]);
  assert.deepEqual(await entry.locator("time").evaluateAll(times => times.map(time => time.dateTime)), ["2026-02-02"]);
  assert.match(await entry.innerText(), /Demo project notes/);
  await link.click();
  assert.equal(await dialog.getByRole("heading", { name: "Connections 1", exact: true }).count(), 1);
});

test("Tied connections keep the same first 20 when a refresh reverses the links", async (t) => {
  const { page, setMode, setVersion } = await open(t);
  setMode("connection-ties");
  await page.goto("http://localhost/relationships?mode=live&q=Demo+Contact");
  await page.locator("#networkNodes").getByRole("button", { name: /Demo Contact/ }).click();
  const dialog = page.getByRole("dialog");
  const linkedIds = () => dialog.locator("[data-open-node]").evaluateAll(
    buttons => buttons.map(button => button.dataset.openNode),
  );
  const expected = Array.from({ length: 20 }, (_, i) => `party:demo-tied-${String(i + 1).padStart(2, "0")}`);
  assert.deepEqual(await linkedIds(), expected);
  setVersion(1);
  await page.clock.fastForward(61000);
  await dialog.getByText("Demo contact refreshed", { exact: true }).waitFor();
  assert.deepEqual(await linkedIds(), expected);
  await dialog.getByRole("button", { name: "Show more", exact: true }).click();
  assert.deepEqual(await linkedIds(), [...expected, "party:demo-tied-21", "party:demo-tied-22"]);
});

test("A failed Connections read shows Retry even while an empty contact is open", async (t) => {
  const h = await open(t), { page } = h;
  h.setMode("fail");
  await page.goto("http://localhost/relationships?mode=live&node=party:demo-isolated");
  const notice = page.locator("#networkNotice");
  await notice.waitFor();
  assert.match(await notice.innerText(), /unavailable/i);
  const retry = notice.getByRole("button", { name: "Retry", exact: true });
  assert.equal(await retry.count(), 1);
  h.setMode("connections");
  await retry.click();
  const dialog = page.getByRole("dialog");
  const empty = dialog.getByText("No connections recorded", { exact: true });
  await empty.waitFor();
  h.setMode("fail");
  await page.clock.fastForward(61000);
  await page.waitForFunction(() => !document.querySelector("#networkNotice").hidden);
  assert.equal(await empty.count(), 0);
  h.setMode("connections");
  await dialog.getByRole("button", { name: "Retry", exact: true }).click();
  await empty.waitFor();
  assert.deepEqual(h.errors, []);
});

test('R7 malformed optional field is rejected without poisoning retained snapshot or later interactions',async t=>{
 const h=await open(t),{page}=h;await page.goto('http://localhost/relationships?mode=live');await page.waitForSelector('.relationship-node');
 const before=await page.locator('#networkCanvas').textContent();h.setMode('territory');await page.clock.fastForward(61000);await page.waitForFunction(()=>!document.querySelector('#networkNotice').hidden);
 assert.equal(await page.locator('#networkCanvas').textContent(),before);await page.locator('#networkReset').click();await page.setViewportSize({width:1000,height:900});await page.locator('#networkZoomIn').click();assert.deepEqual(h.errors,[]);
 assert.equal(await page.locator('.relationship-node').count(),8);assert.equal(await page.locator('#networkUpdated').isVisible(),true);
});

test("W14 drag stays pending during graph resizing and uses the settled center", async (t) => {
  const browser = await chromium.launch();
  let dragging;
  // Drain input before closing its page, including on assertion failure.
  t.after(async () => {
    try { await dragging; } finally { await browser.close(); }
  });
  const page = await browser.newPage();
  await page.clock.install({ time: new Date() });
  await componentDocument(page, 'http://localhost', {html: `
    <style>
      #canvas { width: 820px; transition: width 2s linear; }
      svg { display: block; width: 100%; height: 200px; }
    </style>
    <div id="canvas"><svg viewBox="0 0 820 200">
      <g id="networkScene" transform="translate(0 0)">
        <rect data-node="party:demo-lender" x="300" y="50" width="100" height="100" />
      </g>
    </svg></div>
  `});
  await page.evaluate(() => {
    window.dragInputs = [];
    document.querySelector('[data-node="party:demo-lender"]').addEventListener("pointerdown", event => {
      window.dragInputs.push({ x: event.clientX, y: event.clientY, width: document.querySelector("#canvas").getBoundingClientRect().width });
    });
    document.querySelector("#canvas").getBoundingClientRect();
    document.querySelector("#canvas").style.width = "320px";
  });
  await page.waitForFunction(() => document.getAnimations().some(animation => animation.playState === "running"));
  let completed = false;
  dragging = dragLender(page).then(() => { completed = true; });
  await delay(150);
  assert.equal(completed, false, "drag must stay pending while the target is moving");
  assert.deepEqual(await page.evaluate(() => window.dragInputs), [], "no input before geometry settles");
  await dragging;
  const box = await page.locator('[data-node="party:demo-lender"]').boundingBox();
  const inputs = await page.evaluate(() => window.dragInputs);
  assert.equal(inputs.length, 1);
  assert.equal(inputs[0].width, 320, "measure only after the resize finishes");
  assert.ok(Math.abs(inputs[0].x - (box.x + box.width / 2)) <= 1);
  assert.ok(Math.abs(inputs[0].y - (box.y + box.height / 2)) <= 1);
});

for(const width of [1440,390]) test(`S8 relationship names fit their nodes and structured deal names read as text at ${width}px`,async t=>{
 const {page,setMode}=await open(t,width);setMode('labels');
 await page.goto('http://localhost/relationships?mode=live');
 await page.waitForSelector(width === 390 ? '#networkNodes button' : '.relationship-node');
 assert.doesNotMatch(await page.locator('#networkNodes').textContent(), /"value"/);
 assert.match(await page.locator('#networkNodes').textContent(), /Demo Dental Relocation/);
 const overflow=await page.locator('.relationship-node').evaluateAll(nodes=>nodes.flatMap(n=>{
  const box=n.querySelector('rect').getBoundingClientRect();
  return [...n.querySelectorAll('text,foreignObject')].filter(text=>{const r=text.getBoundingClientRect();return r.left<box.left-1||r.right>box.right+1;}).map(text=>text.textContent);
 }));
 assert.deepEqual(overflow,[]);
 assert.equal(await page.locator('.relationship-edge-label:visible').count(),0,'edge names stay in details rather than colliding with the graph');
 const fonts=await page.locator(width === 390 ? '#networkNodes strong' : '.relationship-node').first().evaluate(n=>{
  if (!n.ownerSVGElement) return parseFloat(getComputedStyle(n).fontSize);
  const svg=n.ownerSVGElement, text=n.querySelector('.node-name')||n.querySelector('text');
  return parseFloat(getComputedStyle(text).fontSize)*svg.getScreenCTM().a;
 });
 assert.ok(fonts>=12, `rendered node text ${fonts}px`);
});

test('Relationships live boot loads its selected adapter without the fixture adapter',async t=>{
 const {page}=await open(t),scripts=[];
 page.on('request',request=>scripts.push(new URL(request.url()).pathname));
 await page.goto('http://localhost/relationships?mode=live');
 await page.locator('#networkNodes [data-node="party:demo-lender"]').waitFor();
 assert.equal(scripts.includes('/js/fixture-client.js'),false);
 assert.equal(scripts.includes('/js/live-client.js'),true);
});


for (const [entry, url, region, button] of [
  ['Home', '/', '#homeIntroductions', '[data-intro-node]'],
  ['Relationships', '/relationships', '#networkIntroductions', '[data-node]'],
]) for (const width of [1440, 390]) for (const theme of ['light', 'dark'])
  test(`H05 ${entry} keeps the recorded introduction path at ${width}px ${theme}`, async t => {
    const { page, errors, setMode } = await open(t, width);
    await page.addInitScript(theme => localStorage.setItem('doctorcre.visual-preferences', JSON.stringify({ theme, walkthroughSeen: { joe: true, dell: true } })), theme);
    setMode('connector');
    await page.goto(`http://localhost${url}?mode=live`);
    const path = page.locator(`${region} ${button}`);
    await path.waitFor();
    assert.equal(await path.locator('.intro-route').innerText(), 'Demo Healthcare Lending → Demo Practice Builders → Demo Dental Expansion');
    await page.locator(`${region} ${button}:enabled`).waitFor();
    await path.focus();
    await page.keyboard.press('Enter');
    await page.locator('.relationship-dialog[open]').waitFor();
    assert.equal(await page.locator('#relationshipTitle').innerText(), 'Demo Dental Expansion');
    await page.keyboard.press('Escape');
    assert.equal(await path.evaluate(node => node === document.activeElement), true);
    await page.addScriptTag({ content: axe.source });
    const audit = await page.evaluate(region => window.axe.run(document.querySelector(region), { runOnly: ['color-contrast'] }), region);
    assert.deepEqual(audit.violations, []);
    assert.deepEqual(audit.incomplete, []);
    await path.screenshot({ path: `out/test-artifacts/w14/h05-path-${entry}-${width}-${theme}.png`, animations: 'disabled' });
    setMode('ok');
    await page.clock.fastForward(61000);
    await page.waitForFunction(region => document.querySelector(`${region} .intro-route`)?.textContent === 'Demo Healthcare Lending → Demo Dental Expansion', region);
    assert.deepEqual(errors, []);
  });


test('H05 introduction details omit internal tags and repeated evidence', async t => {
  const { page, errors, setMode } = await open(t);
  setMode('duplicate');
  await page.goto('http://localhost/?mode=live');
  await page.locator('#homeIntroductions [data-intro-node]').click();
  await page.locator('.relationship-dialog[open]').waitFor();
  const text = await page.locator('.relationship-dialog').innerText();
  assert.doesNotMatch(text, /dental|joe|party:|demo-offer|Details/);
  assert.equal(await page.locator('.relationship-dialog details').count(), 0);
  assert.match(text, /Worked together on equipment financing; offered an introduction/);
  assert.deepEqual(errors, []);
});


test('H05 dates identify the recorded relationship without inventing a meeting', async t => {
  const { page, errors } = await open(t);
  await page.goto('http://localhost/?mode=live');
  await page.locator('#homeIntroductions [data-intro-node]').click();
  await page.locator('.relationship-dialog[open]').waitFor();
  const dates = page.locator('.relationship-dialog time');
  assert.deepEqual(await dates.allTextContents(), ['Referred · Oct 1, 2026', 'Can introduce · Oct 1, 2026']);
  assert.deepEqual(await dates.evaluateAll(nodes => nodes.map(node => node.dateTime)), ['2026-10-01T15:00:00Z', '2026-10-01T15:00:00Z']);
  assert.doesNotMatch(await page.locator('.relationship-dialog').innerText(), /Met on|Employer/);
  assert.deepEqual(errors, []);
});


for (const [entry, url, region] of [
  ['Home', '/', '#homeIntroductions'],
  ['Relationships', '/relationships', '#networkIntroductions'],
]) test(`H05 ${entry} renders route names as literal text`, async t => {
  const { page, errors, setMode } = await open(t);
  setMode('route-text');
  await page.goto(`http://localhost${url}?mode=live`);
  const route = page.locator(`${region} .intro-route`);
  await route.waitFor();
  assert.equal(await route.innerText(), 'Demo <em>Lending</em> & Partners → Demo Dental Expansion');
  assert.equal(await route.locator('em').count(), 0);
  assert.deepEqual(errors, []);
});


test('Home loads introduction details on keyboard entry', async t => {
  const { page, errors } = await open(t, 390);
  let release;
  const requested = Promise.withResolvers();
  const download = new Promise(resolve => { release = resolve; });
  t.after(() => release());
  await page.route('**/js/relationship-dialog.js', async route => {
    requested.resolve();
    await download;
    await route.fallback();
  });
  await page.goto('http://localhost/?mode=live');
  const path = page.locator('#homeIntroductions [data-intro-node]');
  await path.waitFor();
  assert.equal(await path.isEnabled(), true, 'keyboard entry can request its dialog');
  await path.focus();
  await page.keyboard.press('Enter');
  await requested.promise;
  assert.equal(await page.locator('.relationship-dialog[open]').count(), 0);
  release();
  await page.locator('.relationship-dialog[open]').waitFor();
  assert.equal(await page.locator('#relationshipTitle').innerText(), 'Demo Dental Expansion');
  assert.deepEqual(errors, []);
});

for (const width of [1440, 390]) test(`Relationship records open by ID at ${width}px`, async t => {
  const { page, setMode } = await open(t, width);
  setMode('records');
  for (const [id, kind, destination] of [
    ['deal:demo-won', 'deal', '/deals?deal=demo-won'],
    ['party:demo-client', 'client', '/clients?record=demo-client'],
    ['party:demo-lender', 'vendor', '/vendors?record=demo-lender'],
    ['party:isolated-vendor', 'vendor', '/vendors?record=vendor%20%26%201'],
  ]) {
    await page.goto(`http://localhost/relationships?mode=live&node=${encodeURIComponent(id)}`);
    const link = page.getByRole('dialog').getByRole('link', { name: `Open ${kind} record` });
    await link.waitFor();
    assert.equal(await link.getAttribute('href'), destination);
    await link.click();
    await page.waitForURL(`http://localhost${destination}`);
  }
  await page.goto('http://localhost/relationships?mode=live&node=party%3Ademo-isolated');
  const dialog = page.getByRole('dialog');
  await dialog.getByText('No connections recorded').waitFor();
  assert.equal(await dialog.getByRole('link', { name: /Open .* record/ }).count(), 0);
});

for (const surface of ['graph', 'directory']) test(`A refresh keeps ${surface === 'graph' ? 'drawer title' : 'directory opener'} focus`, async t => {
  const { page } = await open(t);
  await page.goto('http://localhost/relationships?mode=live');
  const opener = page.locator(`${surface === 'graph' ? '#networkCanvas' : '#networkNodes'} [data-node="party:demo-build"]`);
  const dialog = page.getByRole('dialog');
  await opener.click();
  await dialog.locator('[data-open-node="party:demo-client"]').click();
  assert.equal(new URL(page.url()).searchParams.get('node'), 'party:demo-client');
  const beforeRefresh = await opener.elementHandle();
  await page.clock.fastForward(61000);
  await page.waitForFunction(el => !el.isConnected, beforeRefresh);
  if (surface === 'graph') {
    const title = dialog.getByRole('heading', { level: 2 });
    assert.equal(await title.evaluate(el => el === document.activeElement), true, 'The drawer title keeps keyboard focus');
  }
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.activeElement.matches('[data-node]'));
  const focus = await opener.evaluate(el => el === document.activeElement ? 'original opener' : document.activeElement.closest('[id]')?.id);
  assert.equal(focus, 'original opener', 'Escape restores focus within the original surface');
  assert.equal(new URL(page.url()).searchParams.has('node'), false);
  await page.locator('#networkKind').selectOption('client');
  await page.locator('#referralsTab').click();
  await page.goBack();
  await dialog.getByText('Demo Practice Builders', { exact: true }).waitFor();
  assert.equal(await page.locator('#networkKind').inputValue(), '');
  assert.equal(await page.locator('#graphTab').getAttribute('aria-selected'), 'true');
  assert.equal(new URL(page.url()).searchParams.has('kind'), false);
});

test('A filtered connection remains open after reload and Forward', async t => {
  const { page } = await open(t);
  await page.goto('http://localhost/relationships?mode=live&kind=vendor&node=party:demo-build');
  const dialog = page.getByRole('dialog');
  const client = dialog.getByRole('link', { name: 'Open client record' });
  await dialog.locator('[data-open-node="party:demo-client"]').click();
  await page.reload();
  await client.waitFor();
  await page.goBack();
  await dialog.getByText('Demo Practice Builders', { exact: true }).waitFor();
  await page.goForward();
  await client.waitFor();
});

for (const read of ['background', 'after reload', 'first load after reload']) test(`Back restores a next step during the ${read} read`, async t => {
  const { page } = await open(t);
  const step = '11111111-1111-4111-8111-111111111111';
  await page.goto(`http://localhost/relationships?mode=live&node=party:demo-build&step=${step}`);
  const dialog = page.getByRole('dialog');
  await dialog.getByText('Demo next step', { exact: false }).waitFor();
  await dialog.locator('[data-open-node="party:demo-client"]').click();
  if (read === 'background') {
    await dialog.locator('[data-open-node="party:demo-build"]').click();
    assert.equal(await dialog.locator('[data-card-key="next-step"]').count(), 0);
    await page.goBack();
    await dialog.getByRole('link', { name: 'Open client record' }).waitFor();
  }
  if (read === 'after reload') { await page.reload(); await dialog.waitFor(); }
  const held = Promise.withResolvers(), requested = Promise.withResolvers();
  await page.route('**/api/v1/business/relationships*', async route => {
    if (!new URL(route.request().url()).searchParams.has('step')) {
      requested.resolve();
      await held.promise;
    }
    await route.fallback();
  });
  if (read === 'first load after reload') await page.reload({ waitUntil: 'domcontentloaded' });
  else await page.clock.fastForward(61000);
  await requested.promise;
  await page.goBack();
  await page.waitForURL(url => url.searchParams.get('step') === step);
  held.resolve();
  await dialog.locator('[data-card-key="next-step"]:focus').filter({ hasText: 'Demo next step' }).waitFor({ timeout: 3000 });
});

test('Back clears the unavailable notice after a refresh removes the linked record', async t => {
  const { page, setMode } = await open(t);
  setMode('records');
  await page.goto('http://localhost/relationships?mode=live');
  await page.locator('#networkNodes [data-node="party:isolated-vendor"]').click();
  setMode('ok');
  await page.clock.fastForward(61000);
  const notice = page.getByText('This record is no longer available.');
  await notice.waitFor({ timeout: 3000 });
  await page.goBack();
  await notice.waitFor({ state: 'hidden', timeout: 3000 });
  await page.goForward();
  await notice.waitFor({ timeout: 3000 });
  await page.reload();
  await notice.waitFor({ timeout: 3000 });
  assert.equal(new URL(page.url()).searchParams.get('node'), 'party:isolated-vendor');
});
