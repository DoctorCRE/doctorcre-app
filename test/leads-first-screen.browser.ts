import assert from "node:assert/strict";
import { mkdir, readFile } from "node:fs/promises";
import test from "node:test";
import type { Page } from "playwright";
import { chromium } from "./browser-harness.mjs";
import { routeLeads } from "./leads-browser-fixture.mjs";
import { lead, workspace } from "./leads-workspace-fixture.mjs";

const stages = ["new", "qualified", "outreach_active", "engaged", "nurture_drip", "opportunity"];
const cities = [
  ["Pensacola", "FL"],
  ["Mobile", "AL"],
  ["Gulf Breeze", "FL"],
  ["Destin", "FL"],
  ["Daphne", "AL"],
];
const { reachability } = JSON.parse(
  await readFile(new URL("./fixtures/lead-reachability/producer.json", import.meta.url), "utf8"),
).cases.reachable;

// Every board stage is populated, New has more than five leads, and Contact evidence has both kinds.
function fullBoard() {
  const board = workspace();
  board.leads = stages.flatMap((stage, s) =>
    Array.from({ length: stage === "new" ? 14 : 6 }, (_, n) => {
      const number = s * 20 + n + 1;
      const [city, state] = cities[number % cities.length] ?? [];
      return lead(number, {
        doctor_name: `Synthetic practice ${number}`,
        stage,
        city,
        state,
        specialty: number % 2 ? "Dental" : "Veterinary",
        owner: number % 3 ? "example-partner" : null,
        ...(number % 4 ? {} : { reachability }),
      });
    }),
  );
  return board;
}

async function openBoard(width: number, height: number, getBoard: typeof workspace = fullBoard) {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width, height }, reducedMotion: "reduce" });
  await routeLeads(page, { getBoard });
  await page.goto("http://localhost/leads");
  await page.locator("#leadBoard .lead-card").first().waitFor();
  return { browser, page };
}

async function capture(page: Page, name: string) {
  const directory = process.env.LEADS_SCREENSHOT_DIR;
  if (!directory) return;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png` });
}

const screen = (page: Page) =>
  page.evaluate(() => {
    const box = (selector: string) => document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
    const main = document.getElementById("appMainSlot") ?? document.documentElement;
    const columns = box("#leadBoard .stage-columns");
    const board = box("#leadBoard");
    return {
      pageScroll: document.documentElement.scrollHeight - innerHeight,
      mainScroll: main.scrollHeight - main.clientHeight,
      board: { top: board.top, bottom: board.bottom, height: board.height },
      toolbarTops: [
        "#leadSearch",
        "#ownerFilter",
        "#marketFilter",
        "#specialtyFilter",
        "#reachabilityFilter",
        "#stageFilter",
      ].map((selector) => Math.round(box(selector).top)),
      countInTopBar: document.querySelector(".app-layout-topbar #leadCount") !== null,
      columns: { left: columns.left, right: columns.right },
      lanes: [...document.querySelectorAll<HTMLElement>("#leadBoard .stage-column")]
        .map((node) => ({ stage: node.dataset.stage, rect: node.getBoundingClientRect() }))
        .filter(({ rect }) => rect.width > 0)
        .map(({ stage, rect }) => ({ stage, left: rect.left, right: rect.right, width: rect.width })),
    };
  });

for (const [width, height] of [
  [1280, 800],
  [1440, 900],
] as const)
  test(`Leads board fills the first screen without a page scroll at ${width}x${height}`, async (t) => {
    const { browser, page } = await openBoard(width, height);
    t.after(() => browser.close());
    await capture(page, `leads-${width}x${height}`);
    const layout = await screen(page);
    const detail = JSON.stringify(layout);
    assert.equal(layout.pageScroll, 0, detail);
    assert.ok(layout.mainScroll <= 0, `the main region does not scroll: ${detail}`);
    assert.equal(layout.countInTopBar, true, "the count sits beside the title");
    assert.equal(
      new Set(layout.toolbarTops).size,
      1,
      `search, filters, Contact evidence and Stage share one row: ${detail}`,
    );
    assert.ok(layout.board.top <= 140, `the board starts near the top: ${detail}`);
    assert.ok(
      layout.board.bottom <= height && layout.board.height >= height / 2,
      `the board fills the height: ${detail}`,
    );
    assert.equal(layout.lanes.length, stages.length, detail);
    for (const end of [false, true]) {
      await page
        .locator("#leadBoard .stage-columns")
        .evaluate((node, end) => node.scrollTo({ left: end ? node.scrollWidth : 0, behavior: "instant" }), end);
      const { lanes, columns } = await screen(page);
      const shown = lanes.filter((lane) => lane.right > columns.left + 1 && lane.left < columns.right - 1);
      assert.ok(
        shown.length >= 3 &&
          shown.every(
            (lane) => lane.left >= columns.left - 0.5 && lane.right <= columns.right + 0.5 && lane.width >= 280,
          ),
        `every lane on screen is whole and readable: ${JSON.stringify({ end, columns, lanes })}`,
      );
    }
    const lane = page.locator('.stage-column[data-stage="new"]');
    await lane.getByRole("button", { name: "Show all 14 New leads", exact: true }).click();
    const stack = await lane.locator(".lead-stack").evaluate((node) => ({
      overflow: node.scrollHeight - node.clientHeight,
      bottom: node.getBoundingClientRect().bottom,
    }));
    assert.ok(
      stack.overflow > 0 && stack.bottom <= height,
      `the column scrolls inside itself: ${JSON.stringify(stack)}`,
    );
    assert.ok((await screen(page)).mainScroll <= 0, "expanding a column does not scroll the page");
  });

test("Leads connection warning is a 32px banner that keeps the board on screen", async (t) => {
  let fail = false;
  const { browser, page } = await openBoard(1440, 900, () => {
    if (fail) throw new Error("synthetic outage");
    return fullBoard();
  });
  t.after(() => browser.close());
  fail = true;
  await page.locator("#refreshBoard").click();
  const banner = page.locator("#leadBoardError");
  await banner.getByRole("button", { name: "Retry", exact: true }).waitFor();
  await capture(page, "leads-1440x900-connection-warning");
  assert.equal(Math.round((await banner.boundingBox())?.height ?? 0), 32);
  const layout = await screen(page);
  assert.ok(layout.mainScroll <= 0 && layout.board.bottom <= 900, JSON.stringify(layout));
});

test("Leads keeps a usable stacked layout at 390x844", async (t) => {
  const { browser, page } = await openBoard(390, 844);
  t.after(() => browser.close());
  await capture(page, "leads-390x844");
  const layout = await page.evaluate(() => ({
    overflow: document.documentElement.scrollWidth > innerWidth,
    firstCard: document.querySelector("#leadBoard .lead-card")?.getBoundingClientRect().top ?? Number.POSITIVE_INFINITY,
    controls: ["#leadSearch", "#ownerFilter", "#marketFilter", "#specialtyFilter", "#stageFilter", "#refreshBoard"].map(
      (selector) => {
        const box = document.querySelector(selector)?.getBoundingClientRect() ?? new DOMRect();
        return { selector, left: box.left, right: box.right, height: box.height };
      },
    ),
  }));
  const detail = JSON.stringify(layout);
  assert.equal(layout.overflow, false, detail);
  assert.ok(layout.firstCard < 844, `a lead shows on the first screen: ${detail}`);
  assert.ok(
    layout.controls.every((control) => control.left >= 0 && control.right <= 390 && control.height >= 44),
    detail,
  );
  await page.locator("#reasonsStrip summary").click();
  assert.equal(
    await page.locator("#reasonsStrip").evaluate((node) => node.hasAttribute("open")),
    true,
    "Reasons to reach out opens from its strip",
  );
});

test("Leads asks for leads without waiting for the identity check", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await routeLeads(page, { getBoard: fullBoard });
  let release = () => {};
  const identity = new Promise<void>((resolve) => {
    release = resolve;
  });
  await page.route("http://localhost/auth/session", async (route) => {
    await identity;
    return route.fallback();
  });
  const boardRead = page.waitForRequest(
    (request) => request.url() === "http://localhost/mcp" && request.postDataJSON()?.params?.name === "lead-board",
  );
  await page.goto("http://localhost/leads");
  await boardRead;
  assert.equal(
    await page.locator("#leadBoard .lead-card").count(),
    0,
    "nothing renders before the identity check answers",
  );
  release();
  await page.locator("#leadBoard .lead-card").first().waitFor();
});
