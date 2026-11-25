import assert from "node:assert/strict";
import { mkdir } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator } from "playwright";
import { appAssetSnapshot } from "../scripts/fixture-app-assets.mjs";
import { startWorkerFixture } from "../scripts/fixture-http.mjs";
import worker from "../src/worker.js";
import { chromium } from "./browser-harness.mjs";
import { ownedServer } from "./fixture-probe.ts";
import { directoryFixture } from "./fixtures/vendor-directory.synthetic.mjs";

const shots = "out/test-artifacts/deal-overview";
await mkdir(shots, { recursive: true });
const laptops = [
  [1280, 720],
  [1440, 779],
] as const;
const dealId = "00000000-0000-4000-8000-00000000d150";
const proposedId = "00000000-0000-4000-8000-00000000da01";
const confirmedId = "00000000-0000-4000-8000-00000000da02";
const session = { actor: { slug: "joe" }, csrf_token: "synthetic-csrf" };
const instruction =
  "Ask the listing agent for the revised floor plan, the parking count and the signage rules. ".repeat(3);

const step = (n: number, owner: string, description: string, due_on: string, extra = {}) => ({
  id: `00000000-0000-4000-8000-00000000a00${n}`,
  owner,
  description,
  due_on,
  status: "open",
  change_id: 3,
  set_by: owner === "joe" ? "Joe" : "Dell",
  set_at: "2026-11-20T15:00:00Z",
  ...extra,
});

const pastTour = {
  id: "00000000-0000-4000-8000-00000000c001",
  activity_id: "00000000-0000-4000-8000-00000000c002",
  happened_at: "2026-11-21T02:30:00Z",
  properties: [
    { property_id: "00000000-0000-4000-8000-00000000c003", address: "100 Example Way", name: "Example Plaza" },
    { property_id: "00000000-0000-4000-8000-00000000c004", address: "200 Sample Road", name: null },
  ],
};

async function openDeal(
  t: TestContext,
  width: number,
  height: number,
  planned: { id: string; planned_on: string }[] = [],
) {
  const server = await startWorkerFixture({
    assets: await appAssetSnapshot(),
    env: { CARR: { fetch: async () => Response.json(session) }, ENGINE_ROUTING: { get: async () => "on" } },
  });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  await page.clock.setFixedTime(new Date("2026-11-25T17:00:00Z"));
  const dates = [
    { id: proposedId, kind: "other", due_on: "2029-03-31", status: "proposed", note: "Read from the example lease" },
    { id: confirmedId, kind: "lease_end", due_on: "2030-06-30", status: "open", source: "Example lease, page 2" },
  ];
  const writes: [string, unknown][] = [];
  const deal = () => ({
    id: dealId,
    deal_id: dealId,
    name: "Example Cedar Dental Relocation",
    client_name: "Example Cedar Dental",
    phase: "site_selection",
    owner: "joe",
    seen: 4 + writes.length,
    kind: "lease",
    reason: "relocation",
    market: "Example City",
    client_portal_url: "https://example.com/portal/cedar",
    next_deal_saves: true,
    next_actions: [
      step(1, "joe", "Tour the three shortlisted suites", "2026-11-27", {
        display_title: "Tour the shortlisted suites",
        display_instruction: instruction,
      }),
      step(2, "dell", "Send the client the market survey", "2026-11-30", { display_instruction: instruction }),
      step(3, "dell", "Call the landlord about the second floor", "2026-12-02"),
    ],
    critical_dates: dates,
    vendors: [],
    email_follow_ups: [],
    correspondence: [
      {
        kind: "email",
        activity_id: "00000000-0000-4000-8000-00000000e001",
        subject: "Example suite floor plan",
        sender_name: "Example Broker",
        happened_at: "2026-11-24T15:00:00Z",
      },
    ],
    documents: [{ id: "00000000-0000-4000-8000-00000000f001", name: "Example lease.pdf", version: 1 }],
  });
  const env = {
    GIT_SHA: "0".repeat(40),
    APP_ENV: "fixture",
    ENGINE_ROUTING: { get: async () => "on" },
    CARR: { fetch: async () => Response.json(session) },
    ENGINE: {
      fetch: async (request: Request) => {
        const path = new URL(request.url).pathname;
        const decided = /^\/api\/engine\/critical-dates\/([^/]+)\/(confirm|resolve)$/.exec(path);
        if (request.method === "POST" && decided) {
          const { idempotency_key: _key, ...body } = await request.json();
          writes.push([path, body]);
          const date = dates.find(({ id }) => id === decided[1]);
          assert.ok(date);
          date.status = body.resolution ?? "open";
          return Response.json({ critical_date_id: date.id, status: date.status });
        }
        if (path === `/api/engine/deals/${dealId}`) return Response.json(deal());
        if (path === `/api/engine/deals/${dealId}/tours`)
          return Response.json({ tours: planned, past_tours: [pastTour] });
        if (path === "/api/engine/deals")
          return Response.json({ schema_version: "local-deals-board.v2", actor: "joe", deals: [deal()] });
        return Response.json({ error: "not_found" }, { status: 404 });
      },
    },
  };
  await page.route(/\/(mcp|api\/engine\/.*)$/, async (route) => {
    const request = route.request();
    const body = request.postData();
    const reply = await worker.fetch(
      new Request(request.url(), {
        method: request.method(),
        headers: await request.allHeaders(),
        ...(body === null ? {} : { body }),
      }),
      env,
    );
    await route.fulfill({
      status: reply.status,
      headers: Object.fromEntries(reply.headers),
      body: Buffer.from(await reply.arrayBuffer()),
    });
  });
  await page.goto(`${server.origin}/deals?mode=live&deal=${dealId}`);
  await page.getByRole("heading", { name: "Critical dates", exact: true }).waitFor();
  await page.waitForLoadState("networkidle");
  return { page, writes };
}

const box = async (locator: Locator) => {
  const bounds = await locator.boundingBox();
  assert.ok(bounds, "shown");
  return bounds;
};

for (const [width, height] of laptops) {
  test(`the overview's first screen shows the deal's facts and next step at ${width}`, async (t) => {
    const { page } = await openDeal(t, width, height);
    await page.screenshot({ path: `${shots}/overview-${width}.png` });
    const firstStep = await box(page.locator(".deal-open-steps .deal-step-owner").first());
    const facts = await box(page.locator(".deal-snapshot-facts"));
    assert.ok(firstStep.y + firstStep.height <= height, "the deal owner's next step is on the first screen");
    assert.ok(facts.y + facts.height <= height, "the deal's facts are on the first screen");
    for (const fact of ["Deal kind", "Deal reason", "Market"])
      assert.ok(await page.locator(".deal-snapshot-facts dt").getByText(fact, { exact: true }).isVisible(), fact);
  });

  test(`each critical date reads as a titled row with its own state and actions at ${width}`, async (t) => {
    const { page, writes } = await openDeal(t, width, height);
    const proposed = page.locator(`[data-date-id="${proposedId}"]`);
    const confirmed = page.locator(`[data-date-id="${confirmedId}"]`);
    await proposed.scrollIntoViewIfNeeded();
    await page.screenshot({ path: `${shots}/critical-dates-${width}.png` });

    for (const [card, title, state, actions] of [
      [proposed, "Other\u00a0· Mar 31, 2029", "Proposed", ["Confirm", "Drop"]],
      [confirmed, "Lease expiration\u00a0· Jun 30, 2030", "Confirmed", ["Mark done", "Drop", "Mark passed"]],
    ] as const) {
      const heading = card.getByRole("heading", { level: 3 });
      assert.equal(await heading.textContent(), title, "kind and date are the title");
      const badge = card.locator(".date-badge");
      assert.equal(await badge.textContent(), state, "the state is its own badge");
      const buttons = card.getByRole("button");
      assert.deepEqual(await buttons.allTextContents(), actions, "only the choices show until one is picked");
      assert.equal(await card.getByLabel("Reason").isVisible(), false, "no reason box until a choice needs one");
      const parts = [await box(heading), await box(badge), ...(await Promise.all((await buttons.all()).map(box)))];
      for (const [i, a] of parts.entries())
        for (const b of parts.slice(i + 1))
          assert.ok(
            a.x + a.width <= b.x || b.x + b.width <= a.x || a.y + a.height <= b.y || b.y + b.height <= a.y,
            "no two parts of a row overlap",
          );
    }

    await proposed.getByRole("button", { name: "Drop", exact: true }).click();
    const reason = proposed.getByLabel("Reason");
    assert.equal(
      await reason.evaluate((input) => input === document.activeElement),
      true,
      "Drop asks for its reason in place",
    );
    assert.deepEqual(await proposed.getByRole("button").allTextContents(), ["Drop", "Cancel"]);
    await page.screenshot({ path: `${shots}/critical-date-drop-${width}.png` });
    await proposed.getByRole("button", { name: "Cancel" }).click();
    assert.deepEqual(await proposed.getByRole("button").allTextContents(), ["Confirm", "Drop"], "Cancel goes back");

    await proposed.getByRole("button", { name: "Drop", exact: true }).click();
    await reason.fill("The example lease was replaced");
    const asked = await proposed.elementHandle();
    await page.getByRole("button", { name: "Refresh deal" }).click();
    await page.waitForFunction((row) => !row?.isConnected, asked);
    assert.equal(await reason.inputValue(), "The example lease was replaced", "the reason survives a refresh");
    assert.deepEqual(await proposed.getByRole("button").allTextContents(), ["Drop", "Cancel"]);
    assert.deepEqual(await confirmed.getByRole("button").allTextContents(), ["Mark done", "Drop", "Mark passed"]);
    await reason.press("Enter");
    await proposed.locator(".date-badge").filter({ hasText: "Dropped" }).waitFor();
    assert.deepEqual(writes, [
      [
        `/api/engine/critical-dates/${proposedId}/resolve`,
        { resolution: "dropped", reason: "The example lease was replaced" },
      ],
    ]);
  });
}

for (const [width, height] of laptops)
  test(`the vendor drawer leaves out office research and target lines at ${width}`, async (t) => {
    const server = await ownedServer();
    t.after(() => server.stop());
    const browser = await chromium.launch();
    t.after(() => browser.close());
    const page = await browser.newPage({ viewport: { width, height } });
    await page.route("https://**", (route) => route.abort());
    await page.route("**/api/v1/business/**", (route) => {
      const url = route.request().url();
      const json = directoryFixture(url);
      if (json.record) Object.assign(json.record, { is_target: false });
      return route.fulfill({ json });
    });
    await page.goto(`${server.url}/vendors`);
    await page.locator(".record-row").first().click();
    const contacts = page.getByRole("region", { name: "Vendor contacts" });
    await contacts.getByText("Demo Contact Alpha", { exact: true }).waitFor();
    await page.screenshot({ path: `${shots}/vendor-drawer-${width}.png` });
    const drawer = page.locator("#recordPanel");
    for (const line of ["Office research", "Not researched", "Needs review", "Office verified", "Target"])
      assert.equal(await drawer.getByText(line, { exact: true }).count(), 0, `no "${line}" line`);
    await contacts.getByText("1 Demo Plaza", { exact: false }).waitFor();
  });

for (const [width, height] of laptops)
  test(`Tours lists past tours under the planned ones at ${width}`, async (t) => {
    const planned = [{ id: "00000000-0000-4000-8000-00000000c005", planned_on: "2026-12-03" }];
    for (const plans of [[], planned]) {
      const { page } = await openDeal(t, width, height, plans);
      await page.getByRole("tab", { name: "Tours" }).click();
      const past = page.getByRole("region", { name: "Past tours" });
      await past.getByRole("heading", { name: "November 20, 2026", exact: true }).waitFor();
      await page.screenshot({ path: `${shots}/tours-${plans.length}-planned-${width}.png` });
      assert.deepEqual(await past.getByRole("listitem").allTextContents(), [
        "November 20, 2026Example Plaza, 100 Example Way200 Sample Road",
        "Example Plaza, 100 Example Way",
        "200 Sample Road",
      ]);
      assert.equal(await past.getByRole("button").count(), 0, "past tours are read-only");
      assert.equal(await page.getByText("No planned tours.").count(), 0, "a past tour means the list is not empty");
      const plan = await box(page.getByRole("button", { name: "Plan tour" }));
      const heading = await box(past.getByRole("heading", { name: "Past tours" }));
      assert.ok(heading.y - (plan.y + plan.height) >= 16, "Past tours has room under Plan tour");
      if (plans.length) {
        const plannedRow = await box(page.getByText("December 3, 2026", { exact: true }));
        assert.ok(plannedRow.y < (await box(past)).y, "past tours sit under the planned ones");
      }
    }
  });

for (const [width, height] of laptops)
  test(`the deal page's header, headings and rows stay compact at ${width}`, async (t) => {
    const { page } = await openDeal(t, width, height);
    const header = await box(page.locator(".workspace-header"));
    const tabs = await box(page.locator("#workspaceTabs"));
    assert.ok(tabs.y - header.y <= 96, "the tabs sit under one heading row and one line of facts");
    const factTops = await page
      .locator(".workspace-facts dd")
      .evaluateAll((all) => all.map((fact) => Math.round(fact.getBoundingClientRect().top)));
    assert.equal(new Set(factTops).size, 1, "the header's facts share one line");

    const list = await box(page.locator(".deal-open-steps ul"));
    const done = await box(page.locator(".deal-open-steps").getByRole("button", { name: "Done" }).first());
    assert.ok(Math.abs(done.x + done.width - (list.x + list.width)) <= 1, "Done sits at the row's end");

    const body = await page.locator("body").evaluate((body) => getComputedStyle(body).fontSize);
    const refresh = page.getByRole("button", { name: "Refresh deal" });
    for (const [tab, heading] of [
      ["Timeline", "Dated events"],
      ["Correspondence & notes", "Correspondence & notes"],
      ["Documents", "Documents"],
    ] as const) {
      await page.getByRole("tab", { name: tab }).click();
      const title = page.getByRole("tabpanel").getByRole("heading", { name: heading, exact: true });
      assert.equal(await title.evaluate((title) => getComputedStyle(title).fontSize), body, `${heading} is body size`);
      const [a, b] = [await box(title), await box(refresh)];
      assert.ok(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= 1, `Refresh shares ${heading}'s row`);
    }
    await page.screenshot({ path: `${shots}/documents-${width}.png` });
    const file = await box(page.getByRole("link", { name: "Example lease.pdf, Version 1" }));
    const open = await box(page.getByRole("button", { name: "Open text for Example lease.pdf, Version 1" }));
    assert.ok(open.y < file.y + file.height && open.x > file.x + file.width, "Open text sits on the file's row");

    await page.getByRole("tab", { name: "Correspondence & notes" }).click();
    const email = page.locator(".evidence-item").filter({ hasText: "Example suite floor plan" });
    const [sender, when] = [await box(email.locator(".evidence-source")), await box(email.locator("time"))];
    assert.equal(Math.round(sender.y), Math.round(when.y), "the sender and time share the row's second line");

    await page.getByRole("tab", { name: "Timeline" }).click();
    const event = await box(page.locator(".workspace-events li").first());
    assert.ok(event.height <= 64, `a two-line timeline row is at most 64px, not ${event.height}`);
  });
