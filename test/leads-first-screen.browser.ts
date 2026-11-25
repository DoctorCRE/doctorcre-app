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
const reasons = JSON.parse(
  await readFile(new URL("./fixtures/reasons-evidence-window/recordings.json", import.meta.url), "utf8"),
);
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

// Fourteen markets: more than one line of the territory strip holds at 1280 or 1440.
function manyMarkets() {
  const board = fullBoard();
  for (const [n, lead] of board.leads.entries()) Object.assign(lead, { city: `Town ${(n % 14) + 1}`, state: "FL" });
  return board;
}

const marketStrip = (page: Page) =>
  page.evaluate(async () => {
    // A resize reaches the "+N" label at the next frame; measure after it.
    await new Promise((settled) => requestAnimationFrame(() => requestAnimationFrame(settled)));
    const strip = document.getElementById("marketCounts")?.getBoundingClientRect() ?? new DOMRect();
    const chips = [...document.querySelectorAll("#marketCounts [data-market]")].map((chip) =>
      chip.getBoundingClientRect(),
    );
    const shown = chips.filter((chip) => chip.top < strip.bottom);
    return {
      sideways: (document.getElementById("marketCounts")?.scrollWidth ?? 0) > Math.ceil(strip.width),
      cut: shown.filter((chip) => chip.left < strip.left - 0.5 || chip.right > strip.right + 0.5).length,
      shown: shown.length,
      folded: chips.length - shown.length,
      more: document.getElementById("moreMarkets")?.checkVisibility()
        ? document.getElementById("moreMarkets")?.textContent
        : null,
    };
  });

for (const width of [1280, 1440])
  test(`Leads folds the markets that do not fit into a +N chip at ${width}`, async (t) => {
    const { browser, page } = await openBoard(width, 800, manyMarkets);
    t.after(() => browser.close());
    await capture(page, `leads-markets-${width}`);
    const strip = await marketStrip(page);
    assert.equal(strip.sideways, false, "the strip does not scroll sideways");
    assert.equal(strip.cut, 0, "no market chip is cut off");
    assert.ok(strip.shown >= 3 && strip.folded > 0, JSON.stringify(strip));
    assert.equal(strip.more, `+${strip.folded}`);
    await page.locator("#moreMarkets").click();
    await capture(page, `leads-markets-${width}-open`);
    const open = await marketStrip(page);
    assert.deepEqual([open.folded, open.cut, open.more], [0, 0, "Fewer"], "+N shows every market");
    assert.equal((await screen(page)).pageScroll, 0, "the page still does not scroll");
  });

// Two markets: the strip has room for both, so nothing folds.
function twoMarkets() {
  const board = fullBoard();
  for (const [n, lead] of board.leads.entries()) Object.assign(lead, { city: n % 2 ? "Mobile" : "Destin" });
  return board;
}

test("Leads shows a focused market chip's whole focus ring", async (t) => {
  const { browser, page } = await openBoard(1280, 800, twoMarkets);
  t.after(() => browser.close());
  await page.keyboard.press("Tab");
  await page.locator("#marketCounts [data-market]").first().focus();
  const ring = await page.evaluate(() => {
    const strip = document.getElementById("marketCounts");
    const chip = strip?.querySelector("[data-market]");
    if (!strip || !chip) throw new Error("no market chip");
    const style = getComputedStyle(chip);
    const reach = Number.parseFloat(style.outlineWidth) + Number.parseFloat(style.outlineOffset);
    const box = chip.getBoundingClientRect();
    const clip = strip.getBoundingClientRect();
    return {
      outline: style.outlineStyle,
      ring: { top: box.top - reach, left: box.left - reach, bottom: box.bottom + reach, right: box.right + reach },
      clip: {
        top: clip.top + strip.clientTop,
        left: clip.left + strip.clientLeft,
        bottom: clip.top + strip.clientTop + strip.clientHeight,
        right: clip.left + strip.clientLeft + strip.clientWidth,
      },
    };
  });
  assert.notEqual(ring.outline, "none", "the chip shows a focus ring");
  const inside =
    ring.ring.top >= ring.clip.top &&
    ring.ring.left >= ring.clip.left &&
    ring.ring.bottom <= ring.clip.bottom &&
    ring.ring.right <= ring.clip.right;
  assert.ok(inside, `the strip does not clip the ring: ${JSON.stringify(ring)}`);
  assert.equal(await page.locator("#moreMarkets").isHidden(), true, "nothing folds");
  assert.equal(await page.locator("#moreMarkets").getAttribute("aria-label"), null, "a hidden +N chip has no label");
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
  const boardRead = page.waitForResponse(
    (response) =>
      response.url() === "http://localhost/mcp" && response.request().postDataJSON()?.params?.name === "lead-board",
  );
  await page.goto("http://localhost/leads");
  await (await boardRead).finished();
  assert.equal(
    await page.locator("#leadBoard .lead-card").count(),
    0,
    "nothing renders before the identity check answers",
  );
  assert.equal(
    await page.evaluate(
      async (path) => (await import(path)).pageDocContext.snapshot().records.length,
      "/js/doc-context.js",
    ),
    0,
    "Ask Doc gets no leads before the identity check answers",
  );
  release();
  await page.locator("#leadBoard .lead-card").first().waitFor();
});

test("Leads names the stages off to the right and scrolls one lane per click", async (t) => {
  const { browser, page } = await openBoard(1440, 900);
  t.after(() => browser.close());
  const ahead = page.locator('[data-lane-step="1"]');
  const back = page.locator('[data-lane-step="-1"]');
  assert.equal(await ahead.getAttribute("aria-label"), "3 more stages");
  assert.equal((await ahead.textContent())?.trim(), "3 more ›");
  assert.equal(await back.isVisible(), false, "nothing to scroll back to at the start");
  await capture(page, "leads-1440x900-more-stages");
  await ahead.click();
  await page.getByRole("button", { name: "2 more stages", exact: true }).waitFor();
  assert.equal(
    await page.evaluate(() => {
      const edge = document.querySelector("#leadBoard .stage-columns")?.getBoundingClientRect() ?? new DOMRect();
      const lane =
        document.querySelector('.stage-column[data-stage="engaged"]')?.getBoundingClientRect() ?? new DOMRect();
      return lane.left >= edge.left - 1 && lane.right <= edge.right + 1;
    }),
    true,
    "one click brings Engaged into view",
  );
  assert.equal(await back.getAttribute("aria-label"), "1 earlier stage");
  await back.focus();
  await page.keyboard.press("Enter");
  await back.waitFor({ state: "hidden" });
  assert.equal(await ahead.evaluate((node) => node === document.activeElement), true, "focus stays on the cue");
});

test("Leads counts the reasons it shows and drops the count on sign-out", async (t) => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  await routeLeads(page, {
    getBoard: fullBoard,
    getReasons: () => ({ ...reasons, cards: [...reasons.cards, { ...reasons.cards[0], id: "not-a-reason" }] }),
  });
  await page.goto("http://localhost/leads");
  const count = page.locator("#reasonsCount");
  await page.waitForFunction(() => document.getElementById("reasonsCount")?.textContent !== "");
  assert.equal(await count.textContent(), `(${reasons.cards.length})`, "a reason the page refuses is not counted");
  await page.evaluate(() => dispatchEvent(new Event("doctorcre-session-invalidated")));
  assert.equal(await count.textContent(), "", "no count stays behind after sign-out");
});

for (const width of [1024, 1280, 1440])
  test(`Leads stage cues never cover a card or a stage heading at ${width}`, async (t) => {
    const { browser, page } = await openBoard(width, 800);
    t.after(() => browser.close());
    const overlaps = () =>
      page.evaluate(() => {
        const cues = [...document.querySelectorAll<HTMLElement>(".lane-cue")].filter((cue) => cue.offsetWidth);
        const covered = [...document.querySelectorAll<HTMLElement>("#leadBoard :is(.lead-card, .stage-head > *)")]
          .map((node) => ({ text: node.textContent?.trim(), box: node.getBoundingClientRect() }))
          .filter(({ box }) => box.width);
        const hit = (a: DOMRect, b: DOMRect) =>
          a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
        return {
          cues: cues.length,
          hits: cues.flatMap((cue) =>
            covered.filter(({ box }) => hit(cue.getBoundingClientRect(), box)).map(({ text }) => text),
          ),
        };
      });
    const start = await overlaps();
    assert.deepEqual(start, { cues: 1, hits: [] }, "the more-stages cue sits clear of the board");
    await page.locator('[data-lane-step="1"]').click();
    await page.locator('[data-lane-step="-1"]').waitFor();
    await capture(page, `leads-${width}x800-stage-cues`);
    assert.deepEqual(await overlaps(), { cues: 2, hits: [] }, "both cues sit clear of the board");
  });

for (const width of [1024, 1280, 1440])
  test(`Leads filters show their whole selected text at ${width}`, async (t) => {
    const { browser, page } = await openBoard(width, 800);
    t.after(() => browser.close());
    await capture(page, `leads-${width}x800-filters`);
    const filters = await page.evaluate(() => {
      const context = document.createElement("canvas").getContext("2d");
      return [...document.querySelectorAll<HTMLSelectElement>(".leads-toolbar select")]
        .filter((select) => select.offsetWidth)
        .map((select) => {
          const style = getComputedStyle(select);
          if (context) context.font = style.font;
          const text = select.selectedOptions[0]?.textContent ?? "";
          return {
            id: select.id,
            text,
            needed: (context?.measureText(text).width ?? 0) + Number.parseFloat(style.paddingLeft),
            width: select.clientWidth,
          };
        });
    });
    assert.ok(filters.length >= 4, JSON.stringify(filters));
    for (const filter of filters)
      assert.ok(filter.width >= filter.needed, `${filter.id} fits "${filter.text}": ${JSON.stringify(filter)}`);
    assert.equal(
      await page.evaluate(() => document.documentElement.scrollHeight - innerHeight),
      0,
      "the page does not scroll",
    );
  });
