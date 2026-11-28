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
const lateId = "00000000-0000-4000-8000-00000000da03";
const soonId = "00000000-0000-4000-8000-00000000da04";
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

type CriticalDate = { id: string; kind: string; due_on: string; status: string; note?: string; source?: string };
const fourDates = (): CriticalDate[] => [
  { id: proposedId, kind: "other", due_on: "2029-03-31", status: "proposed", note: "Read from the example lease" },
  { id: confirmedId, kind: "lease_end", due_on: "2030-06-30", status: "open", source: "Example lease, page 2" },
  { id: soonId, kind: "due_diligence", due_on: "2026-11-30", status: "open" },
  { id: lateId, kind: "loi_expiry", due_on: "2026-11-23", status: "open" },
];
const kinds = [
  "loi_expiry",
  "due_diligence",
  "lease_end",
  "rent_start",
  "option_notice",
  "phase_effective_date",
  "other",
];
const days = ["2026-11-23", "2026-11-25", "2026-11-28", "2026-12-04", "2027-01-15", "2027-06-30", "2028-02-29"];
const twelveDates = (): CriticalDate[] =>
  kinds
    .flatMap((kind, n) => days.slice(n, n + 2).map((due_on) => ({ kind, due_on })))
    .slice(0, 12)
    .map((date, n) => ({
      ...date,
      id: `00000000-0000-4000-8000-00000000db${String(n).padStart(2, "0")}`,
      status: n % 3 ? "open" : "proposed",
    }));

async function openDeal(
  t: TestContext,
  width: number,
  height: number,
  planned: { id: string; planned_on: string }[] = [],
  dates = fourDates(),
  extra: { thread?: Record<string, unknown>[]; [fact: string]: unknown } = {},
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
  const writes: [string, unknown][] = [];
  const { thread = [], ...facts } = extra;
  const notes = [...thread];
  const deal = () => ({
    id: dealId,
    deal_id: dealId,
    name: "Example Cedar Dental Relocation",
    client_name: "Example Cedar Dental",
    client_id: "00000000-0000-4000-8000-00000000c150",
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
    thread: notes,
    ...facts,
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
        if (request.method === "POST" && path === "/api/engine/activities") {
          const body = await request.json();
          writes.push([path, body.summary]);
          const id = `00000000-0000-4000-8000-0000000ee${String(notes.length).padStart(3, "0")}`;
          notes.push({ id, kind: "note", text: body.summary, actor: "joe", created_at: body.happened_at });
          return Response.json({ activity_id: id }, { status: 201 });
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
  await page.getByRole("region", { name: "Critical dates" }).waitFor();
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
    assert.ok(firstStep.y + firstStep.height <= height, "the deal owner's next step is on the first screen");
    const facts = page.locator("#workspaceFacts");
    assert.deepEqual(await facts.locator("dd").allTextContents(), [
      "Example Cedar Dental",
      "Site Selection",
      "Joe",
      "Lease",
      "Relocation",
      "Example City",
    ]);
    assert.equal(
      await facts.getByRole("link", { name: "Example Cedar Dental" }).getAttribute("href"),
      "/clients?record=00000000-0000-4000-8000-00000000c150",
      "the client's name opens the client",
    );
    assert.equal(await page.locator(".deal-snapshot-facts dt").getByText("Market").count(), 0, "facts show once");
  });

  test(`critical dates are one row of tiles, soonest first, at the top of Overview at ${width}`, async (t) => {
    const { page, writes } = await openDeal(t, width, height);
    const row = page.getByRole("region", { name: "Critical dates" });
    await page.screenshot({ path: `${shots}/critical-dates-${width}.png` });
    const tiles = row.locator(".critical-date");
    assert.deepEqual(
      (await tiles.allInnerTexts()).map((text) => text.replace(/\s+/g, " ").trim()),
      [
        "LOI expiry Mon, Nov 23 2 days late",
        "Due diligence Mon, Nov 30 in 5 days",
        "Other proposed Mar 31, 2029 in 28 months Confirm",
        "Lease expiration Jun 30, 2030 in 43 months",
      ],
      "each tile has its name, the date in words and how far off it is",
    );
    assert.deepEqual(await tiles.evaluateAll((all) => all.map((tile) => tile.getAttribute("data-state"))), [
      "overdue",
      "soon",
      "upcoming",
      "upcoming",
    ]);
    const tops = await tiles.evaluateAll((all) => all.map((tile) => Math.round(tile.getBoundingClientRect().top)));
    assert.equal(new Set(tops).size, 1, "the tiles never wrap");
    const add = row.getByRole("button", { name: "Add date" });
    assert.equal(Math.round((await box(add)).y), tops[0], "the add tile ends the row");
    const overview = page.getByRole("tabpanel", { name: "Overview" });
    assert.equal(
      await overview.evaluate((panel) => panel.firstElementChild?.getAttribute("aria-label")),
      "Critical dates",
      "the dates are the Overview tab's first content",
    );
    assert.ok((await box(row)).y < (await box(page.locator(".deal-opening-snapshot"))).y, "dates come first");
    const rowBox = await box(row);
    assert.ok(
      (await box(overview.locator(".deal-freshness"))).y >= rowBox.y + rowBox.height,
      "freshness sits inside Overview under the row",
    );

    await row.getByRole("button", { name: "Lease expiration" }).click();
    const panel = page.getByRole("dialog", { name: "Lease expiration" });
    assert.match((await panel.textContent()) ?? "", /Jun 30, 2030 · Confirmed\s*Example lease, page 2/);
    assert.deepEqual(await panel.getByRole("button").allTextContents(), ["Mark done", "Drop", "Mark passed"]);
    await page.keyboard.press("Escape");

    await tiles.nth(2).getByRole("button", { name: "Confirm" }).click();
    await row.locator(`[data-date-id="${proposedId}"] .date-confirm`).waitFor({ state: "detached" });
    assert.deepEqual(writes, [[`/api/engine/critical-dates/${proposedId}/confirm`, {}]], "Confirm on the tile saves");

    await row.getByRole("button", { name: "LOI expiry" }).click();
    const late = page.getByRole("dialog", { name: "LOI expiry" });
    await late.getByRole("button", { name: "Drop", exact: true }).click();
    const reason = late.getByLabel("Reason");
    assert.equal(await reason.evaluate((input) => input === document.activeElement), true, "Drop asks its reason");
    await reason.fill("The example LOI was withdrawn");
    await page.getByRole("button", { name: "Refresh deal" }).evaluate((button: HTMLElement) => button.click());
    await page.waitForLoadState("networkidle");
    assert.equal(await reason.inputValue(), "The example LOI was withdrawn", "the open date survives a refresh");
    await page.screenshot({ path: `${shots}/critical-date-drop-${width}.png` });
    await reason.press("Enter");
    await row.locator(`[data-date-id="${lateId}"]`).waitFor({ state: "detached" });
    assert.deepEqual(writes.at(-1), [
      `/api/engine/critical-dates/${lateId}/resolve`,
      { resolution: "dropped", reason: "The example LOI was withdrawn" },
    ]);

    await add.click();
    await page.getByRole("dialog", { name: "Add critical date" }).getByLabel("Kind").waitFor();
  });

  test(`a full row of critical dates scrolls sideways and never clips a tile's text at ${width}`, async (t) => {
    const { page } = await openDeal(t, width, height, [], twelveDates());
    const row = page.getByRole("region", { name: "Critical dates" });
    await page.screenshot({ path: `${shots}/critical-dates-full-${width}.png` });
    assert.equal(await row.locator(".critical-date").count(), 12);
    assert.ok(await row.evaluate((node) => node.scrollWidth > node.clientWidth), "the row scrolls");
    const clipped = await row.locator(".critical-date").evaluateAll((tiles) =>
      tiles.flatMap((tile) => {
        const edge = tile.getBoundingClientRect().right;
        return [...tile.querySelectorAll(":scope > h3 > *, :scope > p > *, :scope > p > span > *")]
          .filter((part) => part.scrollWidth > part.clientWidth || part.getBoundingClientRect().right > edge)
          .map((part) => `${tile.querySelector(".date-open")?.textContent}: ${part.textContent}`);
      }),
    );
    assert.deepEqual(clipped, [], "every tile fits its text");
  });

  test(`a deal with no critical dates says so on one line with Add date at ${width}`, async (t) => {
    const { page } = await openDeal(t, width, height, [], []);
    const row = page.getByRole("region", { name: "Critical dates" });
    assert.equal(await row.textContent(), "No critical dates+ Add date");
    assert.ok((await box(row)).height <= 48, "one line");
    await row.getByRole("button", { name: "+ Add date" }).click();
    await page.getByRole("dialog", { name: "Add critical date" }).getByLabel("Kind").waitFor();
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
    await page.goto(`${server.url}/vendors?all=true`);
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
    assert.ok(tabs.y - header.y <= 8, "the tabs open the header, the deal's name being in the top bar");
    const factTops = await page
      .locator(".workspace-facts dd")
      .evaluateAll((all) => all.map((fact) => Math.round(fact.getBoundingClientRect().top)));
    assert.equal(new Set(factTops).size, 1, "the header's facts share one line");

    const step = await box(page.locator(".deal-open-steps li strong").first());
    const done = await box(page.locator(".deal-open-steps").getByRole("button", { name: "Done" }).first());
    assert.ok(done.x + done.width <= step.x, "the Done circle opens the step's row");

    const body = await page.locator("body").evaluate((body) => getComputedStyle(body).fontSize);
    const refresh = page.getByRole("button", { name: "Refresh deal" });
    for (const [tab, heading] of [
      ["Activity", "Activity"],
      ["Documents", "Documents"],
    ] as const) {
      await page.getByRole("tab", { name: tab }).click();
      const title = page.getByRole("tabpanel").getByRole("heading", { name: heading, exact: true });
      assert.equal(await title.evaluate((title) => getComputedStyle(title).fontSize), body, `${heading} is body size`);
      const [a, b] = [await box(title), await box(refresh)];
      assert.ok(Math.abs(a.y + a.height / 2 - (b.y + b.height / 2)) <= 1, `Refresh shares ${heading}'s row`);
      assert.equal(
        await page.getByRole("region", { name: "Critical dates" }).isVisible(),
        false,
        `${tab} hides the dates`,
      );
    }
    await page.screenshot({ path: `${shots}/documents-${width}.png` });
    const file = await box(page.getByRole("link", { name: "Example lease.pdf, Version 1" }));
    const open = await box(page.getByRole("button", { name: "Open text for Example lease.pdf, Version 1" }));
    assert.ok(open.y < file.y + file.height && open.x > file.x + file.width, "Open text sits on the file's row");

    await page.getByRole("tab", { name: "Activity" }).click();
    const email = page
      .getByRole("tabpanel", { name: "Activity" })
      .locator(".activity-row")
      .filter({ hasText: "Example suite floor plan" });
    const [title, meta] = [await box(email.locator(".activity-title")), await box(email.locator(".activity-meta"))];
    assert.ok(meta.y >= title.y + title.height - 1, "the sender and time sit on the row's second line");
    assert.match((await email.locator(".activity-meta").textContent()) ?? "", /Example Broker · Nov 24, 9:00 AM/);

    const event = await box(email);
    assert.ok(event.height <= 64 && event.height >= 34, `a two-line activity row is 34 to 64px, not ${event.height}`);
  });

const noteAt = (n: number) => ({
  id: `00000000-0000-4000-8000-0000000e10${String(n).padStart(2, "0")}`,
  kind: "note",
  text: `Example note ${n}`,
  actor: n % 2 ? "dell" : "joe",
  created_at: `2026-11-${String(10 + n).padStart(2, "0")}T15:00:00Z`,
});
const sideFacts = {
  participants: [
    { role: "referring_agent", name: "Rae Example", party_id: "00000000-0000-4000-8000-00000000b003" },
    { role: "landlord_rep", name: "Avery Sample", party_id: "00000000-0000-4000-8000-00000000b001" },
    { role: "attorney", name: "Example Law", party_id: "00000000-0000-4000-8000-00000000b002" },
    { role: "client_contact", name: "Dr. Example", party_id: "00000000-0000-4000-8000-00000000b004" },
  ],
  invoice: {
    trigger: "lease_signed",
    triggered_on: "2026-11-20",
    payments: [{ id: "p1", sent_on: "2026-11-23", paid_on: null }],
  },
};

for (const [width, height] of laptops)
  test(`Overview ends with Latest activity, Invoice and People, and no watch or context controls at ${width}`, async (t) => {
    const thread = Array.from({ length: 10 }, (_, n) => noteAt(n));
    const { page, writes } = await openDeal(t, width, height, [], fourDates(), { ...sideFacts, thread });
    await page.screenshot({ path: `${shots}/overview-side-${width}.png`, fullPage: true });
    const overview = page.getByRole("tabpanel", { name: "Overview" });
    for (const gone of ["Deal watch settings", "Client & vendor context", "Updates"])
      assert.equal(await page.locator("#recordPanel").getByText(gone, { exact: true }).count(), 0, `no "${gone}"`);

    const latest = overview.getByRole("region", { name: "Latest activity" });
    const rows = latest.locator(".activity-title");
    assert.equal(await rows.count(), 8, "the last eight things");
    assert.deepEqual(
      (await rows.allTextContents()).slice(0, 2),
      ["Example suite floor plan", "Example note 9"],
      "newest first",
    );
    const [steps, middle] = [await box(overview.locator(".deal-next-steps")), await box(latest)];
    assert.ok(middle.x >= steps.x + steps.width, "Latest activity sits beside Next steps");

    const people = overview.getByRole("region", { name: "People" });
    assert.deepEqual(await people.getByRole("listitem").allTextContents(), [
      "Example Cedar Dental Client",
      "Dr. Example Client contact",
      "Avery Sample Landlord's broker",
      "Example Law Attorney",
      "Rae Example Referring agent",
    ]);
    assert.equal(
      await people.getByRole("link", { name: /Avery Sample/ }).getAttribute("href"),
      "/vendors?record=00000000-0000-4000-8000-00000000b001",
    );
    for (const [name, id] of [
      [/Dr. Example/, "b004"],
      [/Rae Example/, "b003"],
    ] as const)
      assert.equal(
        await people.getByRole("link", { name }).getAttribute("href"),
        `/relationships?node=party:00000000-0000-4000-8000-00000000${id}`,
      );
    const invoice = overview.getByRole("region", { name: "Invoice" });
    assert.deepEqual(await invoice.locator("dl > div").allInnerTexts(), [
      "Triggered\nNov 20, 2026",
      "Sent\nNov 23, 2026",
      "Paid\nNot yet",
    ]);

    const note = latest.getByLabel("Deal note", { exact: true });
    await note.fill("Example landlord called back");
    await note.press("Enter");
    await rows.first().filter({ hasText: "Example landlord called back" }).waitFor();
    assert.deepEqual(writes.at(-1), ["/api/engine/activities", "Example landlord called back"], "Enter saves the note");

    await rows.nth(2).click();
    const activity = page.getByRole("tabpanel", { name: "Activity" });
    await activity.getByRole("heading", { name: "Example note 9" }).waitFor();
    await page.getByRole("tab", { name: "Overview" }).click();
    await latest.getByRole("button", { name: "All activity" }).click();
    assert.equal(await activity.isVisible(), true, "All activity opens Activity");
  });

// Eight to-dos in the current phase, as on a real deal well into site selection.
const longChecklist = {
  schema_version: "deal-checklist.v1",
  template_state: "current",
  due_items: [],
  phases: [
    {
      id: "site_selection",
      label: "Site selection",
      items: Array.from({ length: 8 }, (_, n) => ({
        id: `site_todo_${n}`,
        label: [
          "Market survey",
          "Representation agreement",
          "Terms comparison",
          "Agreed business terms",
          "Lease draft to attorney",
          "Executed lease",
          "Invoice",
          "Commission received",
        ][n],
        status: n < 2 ? "complete" : n === 2 ? "overdue" : "not_recorded",
        due_on: n === 2 ? "2026-11-24" : null,
      })),
    },
  ],
};

const signingPlan = {
  phases: [{ phase: "site_selection", from_on: "2026-11-23", expected_to_on: "2026-12-05" }],
  rows: Array.from({ length: 25 }, (_, i) => ({
    id: `date-${i}`,
    kind: "critical_date",
    phase: "site_selection",
    label: `Example date ${i}`,
    status: "open",
    on: "2026-12-05",
  })),
  arrows: [],
  expected_signing_on: "2026-12-05",
  stale: null,
};
const automaticMove = {
  source: "call_capture",
  automatic: true,
  event_id: "00000000-0000-4000-8000-00000000e160",
  evidence_date: "2026-11-23",
  undoable: true,
  prior_phase: "research",
  phase: "site_selection",
  call: { happened_at: "2026-11-23T18:00:00Z" },
};

test("at 320x568 the move receipt, Undo and forecast each have their own tap target", async (t) => {
  const { page } = await openDeal(t, 320, 568, [], [], { plan: signingPlan, phase_change: automaticMove });
  const status = page.locator("#workspaceStatus");
  const receipt = status.locator("summary");
  const undo = status.getByRole("button", { name: "Undo" });
  await receipt.tap({ timeout: 3000 });
  await status
    .locator("details[open]")
    .getByText(/Call on /)
    .waitFor();
  await receipt.tap();
  await undo.tap({ trial: true });
  await status.getByRole("button", { name: "Lease signing expected Dec 5" }).tap();
  assert.equal(await page.getByRole("tabpanel", { name: "Plan" }).isVisible(), true);
});

test("at 320x568 the Plan list keeps the owner controls in reach", async (t) => {
  const { page } = await openDeal(t, 320, 568, [], [], { plan: signingPlan });
  await page.getByRole("tab", { name: "Plan" }).tap();
  const plan = page.getByRole("tabpanel", { name: "Plan" });
  await plan.getByRole("list", { name: "Plan items" }).waitFor();
  for (const name of ["Both", "Dell", "Joe"]) {
    const owner = plan.getByRole("button", { name, exact: true });
    await owner.tap();
    assert.equal(await owner.getAttribute("aria-pressed"), "true");
  }
  assert.equal(await plan.getByRole("group", { name: "Zoom" }).count(), 0);
  assert.equal(await plan.getByRole("button", { name: "Today", exact: true }).count(), 0);
});

for (const [width, height] of [
  [320, 568],
  [390, 844],
  [900, 599],
  [1280, 599],
  [1280, 640],
  [1440, 900],
] as const)
  test(`at ${width}x${height} deal header and Plan toolbar items fit without overlap`, async (t) => {
    const { page } = await openDeal(t, width, height, [], fourDates(), {
      ...sideFacts,
      plan: signingPlan,
      phase_change: automaticMove,
    });
    await page.getByRole("tab", { name: "Plan" }).click();
    const item = page
      .locator("#workspace-plan :is(.timeline-name, .deal-plan-item > button)")
      .filter({ hasText: "Example date 0" });
    await item.waitFor();
    const geometryProblems = () =>
      page.evaluate(() => {
        const regions =
          ":is(#appTopbar, .workspace-header, #workspace-plan .timeline-tools, .deal-plan-mobile, .deal-plan-footer, .deal-plan-details)";
        const buttons = "button, a[href], summary, input, select, [role=button]";
        const controls = `${regions} :is(${buttons}):not(.deal-plan-item > button)`;
        const statuses = `${regions} [role=status]:not(:empty), #panelTitle, .workspace-facts dd:not(:has(a)), .deal-plan-count`;
        const scrollers = [
          ...document.querySelectorAll("#workspace-plan :is(.timeline-scroll, .deal-plan-list, .deal-plan-details)"),
        ].filter((node) => node.checkVisibility() && ["auto", "scroll"].includes(getComputedStyle(node).overflowY));
        const clientBounds = (node: Element) => {
          const { left, top } = node.getBoundingClientRect();
          return new DOMRect(left + node.clientLeft, top + node.clientTop, node.clientWidth, node.clientHeight);
        };
        const inside = (rect: DOMRect, outer: DOMRect) =>
          rect.left >= outer.left - 0.5 &&
          rect.top >= outer.top - 0.5 &&
          rect.right <= outer.right + 0.5 &&
          rect.bottom <= outer.bottom + 0.5;
        const viewport = new DOMRect(0, 0, innerWidth, innerHeight);
        const boxes = [...document.querySelectorAll(`${controls}, ${statuses}`)]
          .filter((node) => node.checkVisibility({ visibilityProperty: true }))
          .map((node) => ({
            node,
            name: node.getAttribute("aria-label") ?? node.textContent?.trim() ?? node.tagName,
            rect: node.getBoundingClientRect(),
          }))
          .filter(({ rect }) => rect.height > 0 && rect.width > 0);
        return [
          ...scrollers
            .filter((node) => node.clientHeight < 160)
            .map((node) => `${node.className} scroller is ${node.clientHeight}px tall`),
          ...boxes.flatMap(({ node, name, rect }, i) => {
            const issues = [];
            if (!inside(rect, viewport)) issues.push(`${name} is outside the viewport`);
            for (let parent = node.parentElement; parent; parent = parent.parentElement) {
              const { overflowX, overflowY } = getComputedStyle(parent);
              if ((overflowX !== "visible" || overflowY !== "visible") && !inside(rect, clientBounds(parent))) {
                issues.push(`${name} is clipped by ${parent.id || parent.className}`);
                break;
              }
            }
            if (node.matches(buttons)) {
              const hit = document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2);
              if (hit?.closest(".deal-plan-details, [popover]:popover-open") && !node.contains(hit))
                issues.push(`${name} is covered by the opened item`);
            }
            for (const other of boxes.slice(i + 1)) {
              if (
                !node.contains(other.node) &&
                Math.min(rect.right, other.rect.right) - Math.max(rect.left, other.rect.left) > 0.5 &&
                Math.min(rect.bottom, other.rect.bottom) - Math.max(rect.top, other.rect.top) > 0.5
              )
                issues.push(`${name} overlaps ${other.name}`);
            }
            return issues;
          }),
        ];
      });
    const receipt = page.locator("#workspacePhaseMove summary");
    const closed = await geometryProblems();
    await receipt.click();
    const open = await geometryProblems();
    await receipt.click();
    await item.click();
    const itemOpen = await geometryProblems();
    assert.deepEqual({ closed, open, itemOpen }, { closed: [], open: [], itemOpen: [] });
  });

for (const width of [900, 1280])
  test(`at ${width}x599 the deal status stays clear of the path and Plan fits`, async (t) => {
    const { page } = await openDeal(t, width, 599, [], fourDates(), {
      ...sideFacts,
      checklist: longChecklist,
      plan: signingPlan,
      phase_change: automaticMove,
    });
    const tabs = page.getByRole("tablist");
    assert.deepEqual(await tabs.getByRole("tab").allTextContents(), [
      "Overview",
      "Plan",
      "Activity",
      "Tours",
      "Documents",
      "Client portal",
    ]);
    const outer = page.locator("#appMainSlot");
    const fits = () => outer.evaluate((node) => node.scrollHeight <= node.clientHeight && node.scrollTop === 0);
    const signing = page.getByRole("button", { name: "Lease signing expected Dec 5" });
    await signing.waitFor();
    const height = await signing.evaluate((node) => node.getBoundingClientRect().height);
    assert.ok(height >= 28 && height <= 32, `the forecast button is ${height}px high with a mouse`);
    if (width === 1280) assert.equal(await fits(), true, "the forecast and all six tabs fit with Overview");
    const status = page.locator("#workspaceStatus");
    const receipt = status.locator("summary");
    await receipt.getByText("Moved automatically", { exact: true }).waitFor();
    const statusHeight = await status.evaluate((node) => node.clientHeight);
    await receipt.click();
    assert.equal(
      await status.evaluate((node) => node.clientHeight),
      statusHeight,
      "reading the receipt keeps the status height",
    );
    await receipt.click();
    const tile = page.locator('.deal-path-tile[data-place="current"]');
    const more = tile.getByText("6 more", { exact: true });
    assert.ok(
      await more.evaluate((node) => {
        const tile = node.closest(".deal-path-tile");
        return tile !== null && node.getBoundingClientRect().bottom <= tile.getBoundingClientRect().bottom;
      }),
    );
    await more.click();
    await tile.getByRole("button", { name: "Show less" }).click();
    await signing.click();
    await page.getByRole("button", { name: "Example date 0", exact: true }).first().waitFor();
    assert.equal(await fits(), true, "the outer page does not scroll on Plan");
    for (const selector of [".timeline-scroll", ".deal-plan-list"]) {
      const column = page.locator(`#workspace-plan ${selector}`);
      assert.ok(
        await column.evaluate((node) => node.scrollHeight > node.clientHeight),
        `${selector} scrolls inside Plan`,
      );
    }
  });

for (const [width, height] of [
  [1280, 599],
  [1280, 640],
  [1440, 900],
] as const)
  test(`Overview is one screen at ${width}x${height}: dates on top, a short path, columns scroll inside`, async (t) => {
    const thread = Array.from({ length: 10 }, (_, n) => noteAt(n));
    const { page } = await openDeal(t, width, height, [], fourDates(), {
      ...sideFacts,
      thread,
      checklist: longChecklist,
    });
    await page.screenshot({ path: `${shots}/overview-fit-${width}x${height}.png` });
    const dates = page.locator(".critical-dates");
    assert.ok(
      await dates.evaluate((node) => node.clientHeight >= 44 && node.clientHeight >= node.scrollHeight),
      "the dates row shows whole",
    );
    const scroller = page.locator("#appMainSlot");
    assert.ok(
      await scroller.evaluate((node) => node.scrollHeight <= node.clientHeight),
      "the page itself does not scroll",
    );
    assert.equal(
      await scroller.evaluate((node) => getComputedStyle(node).scrollbarWidth),
      "none",
      "the page shows no bar",
    );
    const path = page.locator(".deal-path-section");
    assert.ok((await path.evaluate((node) => node.getBoundingClientRect().height)) <= 200, "the path stays short");
    const current = page.locator('.deal-path-tile[data-place="current"]');
    assert.equal(await current.locator(":scope > ul [data-todo]").count(), 2);
    await current.getByText("6 more").click();
    assert.equal(
      await current.locator(".deal-path-list-panel [data-todo]").count(),
      6,
      "6 more opens the remaining list",
    );
    await current.getByText("6 more").click();
    const columns = page.locator(".deal-overview-grid > *");
    for (const box of await columns.evaluateAll((all) => all.map((node) => node.getBoundingClientRect())))
      assert.ok(
        box.bottom <= height && box.height >= 180,
        `a column is on screen and usable, not ${box.top}-${box.bottom}`,
      );
    const steps = columns.first();
    assert.ok(await steps.evaluate((node) => node.scrollHeight > node.clientHeight), "the long Next steps scroll");
    assert.equal(await steps.evaluate((node) => getComputedStyle(node).scrollbarWidth), "none", "no bar at rest");
  });

for (const [width, height] of [
  [1280, 599],
  [1100, 600],
  [1279, 600],
] as const) {
  test(`Overview stays on screen at ${width}x${height} with more to-dos open`, async (t) => {
    const { page } = await openDeal(t, width, height, [], fourDates(), {
      ...sideFacts,
      thread: Array.from({ length: 10 }, (_, n) => noteAt(n)),
      checklist: {
        ...longChecklist,
        phases: longChecklist.phases.map((phase) => ({
          ...phase,
          items: [
            ...phase.items,
            ...Array.from({ length: 4 }, (_, i) => ({
              id: `more-${i}`,
              label: `Example unfinished checklist item ${i}`,
              status: "not_recorded",
              due_on: null,
            })),
          ],
        })),
      },
    });
    {
      await page.screenshot({ path: `${shots}/polish-${width}x${height}-closed.png` });
      const current = page.locator('.deal-path-tile[data-place="current"]');
      const more = current.getByText("10 more");
      const columns = page.locator(".deal-overview-grid");
      const before = await columns.boundingBox();
      for (const list of await current.locator(":scope > ul").all()) {
        assert.equal(await list.evaluate((n) => n.scrollHeight <= n.clientHeight), true, "tile to-dos are not clipped");
      }
      await more.focus();
      await page.keyboard.press("Enter");
      await page.screenshot({ path: `${shots}/polish-${width}x${height}-open.png` });
      const panel = current.locator(".deal-path-list-panel");
      assert.equal(await panel.locator("[data-todo]").count(), 10);
      assert.equal(await current.locator("[data-todo]").count(), 12);
      await page.keyboard.press("Tab");
      assert.equal(
        await panel.getByRole("button", { name: "Show less" }).evaluate((n) => n === document.activeElement),
        true,
      );
      await page.waitForFunction(
        () =>
          !!document.querySelector<HTMLElement>('.deal-path-tile[data-place="current"] .deal-path-list-panel')?.style
            .top,
      );
      const box = await panel.boundingBox();
      const tile = await current.boundingBox();
      assert.ok(box && tile && box.y >= tile.y + tile.height && box.y + box.height <= height);
      assert.deepEqual(await columns.boundingBox(), before, "opening does not resize columns");
      assert.equal(
        await panel.evaluate((n) => n.scrollHeight > n.clientHeight),
        true,
        "the remaining list scrolls inside the panel",
      );
      await panel.evaluate((n) => {
        n.scrollTop = n.scrollHeight;
      });
      const last = await panel.locator('[data-todo="site_todo_1"]').boundingBox();
      const scrolledPanel = await panel.boundingBox();
      assert.ok(last && scrolledPanel && last.y + last.height <= scrolledPanel.y + scrolledPanel.height);
      await panel.evaluate((n) => {
        n.scrollTop = 0;
      });
      await page.screenshot({ path: `${shots}/polish-${width}x${height}-open.png` });
      await panel.getByRole("button", { name: "Show less" }).click();
      assert.equal(await panel.isVisible(), false);
      assert.equal(await more.evaluate((n) => n === document.activeElement), true);
      await page.keyboard.press("Space");
      await page.evaluate(() => {
        const dialog = document.createElement("dialog");
        dialog.id = "test-dialog";
        document.body.append(dialog);
        dialog.show();
      });
      await page.keyboard.press("Escape");
      assert.equal(await panel.isVisible(), true, "Escape leaves the panel open while a dialog is open");
      await page.evaluate(() => document.querySelector("#test-dialog")?.remove());
      await page.keyboard.press("Escape");
      assert.equal(await panel.isVisible(), false);
      assert.equal(await more.evaluate((n) => n === document.activeElement), true);
      await more.click();
      const note = page.getByRole("textbox", { name: "Deal note" });
      const noteBox = await note.boundingBox();
      assert.ok(noteBox);
      await note.click({ position: { x: noteBox.width - 10, y: 10 } });
      assert.equal(await panel.isVisible(), false);
      assert.equal(await note.evaluate((n) => n === document.activeElement), true);
      await more.click();
      await page.locator(".deal-path > .deal-path-tile").first().getByText("Nothing listed").click();
      assert.equal(await more.evaluate((n) => n === document.activeElement), true);
      assert.deepEqual(await columns.boundingBox(), before, "closing preserves columns");
      await more.click();
    }
    await page.screenshot({ path: `${shots}/polish-${width}x${height}.png` });
    assert.equal(
      await page.locator("#appMainSlot").evaluate((n) => n.scrollHeight === n.clientHeight),
      true,
      "page does not scroll",
    );
    for (const box of await page
      .locator(".deal-overview-grid > *")
      .evaluateAll((all) => all.map((n) => n.getBoundingClientRect())))
      assert.ok(box.bottom <= height && box.height >= 180, "columns remain visible and usable");
  });
}

const denseChecklist = {
  schema_version: "deal-checklist.v1",
  template_state: "current",
  due_items: [],
  phases: ["pending", "research", "site_selection", "negotiation", "legal", "due_diligence", "closing", "closed"].map(
    (id) => ({
      id,
      label: id,
      items: [
        "Commencement letter and possession dates",
        "Executed lease / amendment",
        "RFP / LOI versions and submission",
      ].map((label, n) => ({ id: `${id}_${n}`, label, status: "not_recorded" })),
    }),
  ),
};

for (const [width, height] of [
  [1280, 599],
  [1100, 600],
  [1279, 600],
] as const) {
  test(`long phase labels fit the Overview at ${width}x${height}`, async (t) => {
    const { page } = await openDeal(t, width, height, [], fourDates(), {
      ...sideFacts,
      thread: Array.from({ length: 10 }, (_, n) => noteAt(n)),
      checklist: denseChecklist,
    });
    const path = page.locator(".deal-path");
    await page.screenshot({ path: `${shots}/long-labels-${width}x${height}.png` });
    assert.ok((await path.evaluate((n) => n.getBoundingClientRect().height)) <= 160, "the path remains compact");
    assert.equal(await page.locator("#appMainSlot").evaluate((n) => n.scrollHeight === n.clientHeight), true);
    for (const box of await page
      .locator(".deal-overview-grid > *")
      .evaluateAll((all) => all.map((n) => n.getBoundingClientRect())))
      assert.ok(box.bottom <= height && box.height >= 180);
    const names = path.locator(".deal-path-name");
    assert.equal(
      await names.evaluateAll((all) => all.every((n) => n.getAttribute("title") === n.textContent)),
      true,
      "the full phase name remains available",
    );
    assert.equal(
      await path
        .locator("button.deal-path-name")
        .evaluateAll((all) =>
          all.every(
            (n) =>
              Math.round(n.getBoundingClientRect().height) ===
              Number.parseFloat(getComputedStyle(n).getPropertyValue("--touch")),
          ),
        ),
      true,
      "phase buttons stay at the control height",
    );
    const current = path.locator('[data-place="current"]');
    const label = current.locator(":scope > ul [data-todo]").first().locator("summary");
    assert.equal(await label.getAttribute("title"), "Commencement letter and possession dates");
    assert.equal(await label.textContent(), "Commencement letter and possession dates");
    assert.ok(
      await label.locator("span").evaluate((n) => n.clientHeight <= 32),
      "the tile label is limited to two lines",
    );
    await current.getByText("1 more").click();
    const panelLabel = current.locator(".deal-path-list-panel").getByText("RFP / LOI versions and submission");
    assert.equal(await panelLabel.count(), 1);
    assert.equal(
      await panelLabel.evaluate((n) => n.scrollHeight <= n.clientHeight),
      true,
      "the panel label is complete",
    );
    assert.equal(await page.locator("#appMainSlot").evaluate((n) => n.scrollHeight === n.clientHeight), true);
  });
}

test("narrow Overview uses only one scrollbar", async (t) => {
  const { page } = await openDeal(t, 1000, 700, [], fourDates(), { ...sideFacts, checklist: longChecklist });
  const scroller = page.locator("#appMainSlot");
  await scroller.evaluate((n) => {
    n.scrollTop = 100;
  });
  await page.screenshot({ path: `${shots}/polish-1000x700.png` });
  assert.equal(await scroller.evaluate((n) => getComputedStyle(n).scrollbarWidth), "none", "native bar is hidden");
  assert.equal(await page.locator(".scroll-thumb").count(), 1, "the custom thumb is visible");
});

test("on a phone Overview is one column in the design's order with 16px text", async (t) => {
  const { page } = await openDeal(t, 390, 844, [], fourDates(), sideFacts);
  const order = await page
    .locator(
      ".deal-overview-grid :is(#deal-next-steps-heading, #deal-latest-heading, #deal-invoice-heading, #deal-people-heading)",
    )
    .evaluateAll((all) => all.map((node) => [node.textContent, Math.round(node.getBoundingClientRect().left)]));
  assert.deepEqual(
    order.map(([name]) => name),
    ["Next steps", "Latest activity", "Invoice", "People"],
  );
  assert.equal(new Set(order.map(([, left]) => left)).size <= 2, true, "one column");
  assert.equal(
    await page
      .locator(".deal-latest .activity-title")
      .first()
      .evaluate((n) => getComputedStyle(n).fontSize),
    "16px",
  );
});
