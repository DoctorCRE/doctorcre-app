import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import { type Descriptor, startFixture } from "../scripts/fixture-http.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";
import type {
  RowBox,
  TimelineDate,
  TimelineGroup,
  TimelineLink,
  TimelinePartner,
  TimelinePhase,
  TimelinePhaseBar,
  TimelineProps,
  TimelineRow,
  TimelineStep,
  TimelineTodo,
} from "../src/ui/timeline.tsx";
import { chromium } from "./browser-harness.mjs";

// A made-up lease deal's plan: phases folding over to-dos, steps and critical dates.
const doneTodo = (
  id: string,
  phase: TimelinePhase,
  name: string,
  start: string,
  end: string,
  when: string,
): TimelineTodo => ({
  id,
  kind: "todo",
  phase,
  name,
  state: "done",
  start,
  end,
  when,
});
const expTodo = (
  id: string,
  phase: TimelinePhase,
  name: string,
  start: string,
  end: string,
  when: string,
  length: string,
  atRisk?: boolean,
): TimelineTodo => ({
  id,
  kind: "todo",
  phase,
  name,
  state: "expected",
  start,
  end,
  when,
  length,
  ...(atRisk && { atRisk }),
});
const phaseBar = (phase: TimelinePhase, start: string, end: string): TimelinePhaseBar => ({ phase, start, end });
const openStep = (
  id: string,
  phase: TimelinePhase,
  owner: TimelinePartner,
  name: string,
  start: string,
  due: string,
  when: string,
): TimelineStep => ({
  id,
  kind: "step",
  phase,
  owner,
  name,
  state: "open",
  start,
  due,
  when,
});
const doneStep = (
  id: string,
  phase: TimelinePhase,
  owner: TimelinePartner,
  name: string,
  start: string,
  end: string,
  when: string,
): TimelineStep => ({
  id,
  kind: "step",
  phase,
  owner,
  name,
  state: "done",
  start,
  end,
  when,
});
const dateRow = (
  id: string,
  phase: TimelinePhase,
  name: string,
  day: string,
  state: TimelineDate["state"],
  when: string,
  atRisk?: boolean,
): TimelineDate => ({
  id,
  kind: "date",
  phase,
  name,
  day,
  state,
  when,
  ...(atRisk && { atRisk }),
});

const GROUPS: readonly TimelineGroup[] = [
  {
    id: "pending",
    name: "Prospective Client",
    count: "Nothing listed",
    bar: phaseBar("pending", "2026-09-30", "2026-10-07"),
    startsFolded: false,
    rows: [],
  },
  {
    id: "research",
    name: "Research",
    count: "2 of 2",
    done: true,
    bar: phaseBar("research", "2026-10-07", "2026-10-26"),
    startsFolded: true,
    rows: [
      doneTodo("rep", "research", "Representation agreement", "2026-10-07", "2026-10-12", "Oct 12"),
      doneTodo("req", "research", "Intake and requirements", "2026-10-12", "2026-10-24", "Oct 24"),
    ],
  },
  {
    id: "site",
    name: "Site Selection",
    count: "2 of 2",
    done: true,
    bar: phaseBar("site_selection", "2026-10-26", "2026-11-12"),
    startsFolded: false,
    rows: [
      doneTodo("survey", "site_selection", "Market survey", "2026-10-26", "2026-11-01", "Nov 1"),
      doneTodo("tours", "site_selection", "Tours and tour notes", "2026-11-01", "2026-11-10", "Nov 10"),
      doneStep(
        "tour-step",
        "site_selection",
        "Joe",
        "Book the four-property tour",
        "2026-10-29",
        "2026-11-04",
        "Done Nov 4",
      ),
    ],
  },
  {
    id: "neg",
    name: "Negotiating",
    count: "1 of 3",
    bar: phaseBar("negotiation", "2026-11-12", "2026-12-27"),
    startsFolded: false,
    rows: [
      doneTodo("loi", "negotiation", "LOIs sent", "2026-11-12", "2026-11-16", "Nov 16"),
      doneStep(
        "counter-done",
        "negotiation",
        "Dell",
        "Send the Demo Row counter",
        "2026-11-13",
        "2026-11-17",
        "Done Nov 17",
      ),
      {
        id: "terms",
        kind: "todo",
        phase: "negotiation",
        name: "Terms comparison",
        state: "current",
        start: "2026-11-16",
        end: "2026-12-07",
        progress: "day 9 of 21",
        when: "exp. Dec 7",
      },
      openStep(
        "late-step",
        "negotiation",
        "Dell",
        "Call Demo Reyes about the counter",
        "2026-11-18",
        "2026-11-24",
        "Tue, Nov 24",
      ),
      openStep(
        "open-step",
        "negotiation",
        "Joe",
        "Send Demo Voss the LOI comparison",
        "2026-11-23",
        "2026-11-27",
        "Fri, Nov 27",
      ),
      dateRow("loi-expiry", "negotiation", "LOI expiry", "2026-12-03", "confirmed", "Dec 3", true),
      expTodo("agreed", "negotiation", "Agreed business terms", "2026-12-07", "2026-12-27", "exp. Dec 27", "20d", true),
      dateRow("space-held", "negotiation", "Space held until", "2026-11-30", "confirmed", "Nov 30", true),
    ],
  },
  {
    id: "legal",
    name: "Legal",
    count: "0 of 4",
    bar: phaseBar("legal", "2026-12-27", "2027-02-20"),
    startsFolded: false,
    rows: [
      expTodo("legal0", "legal", "Lease draft to attorney", "2026-12-27", "2027-01-06", "exp. Jan 6", "10d"),
      expTodo("legal1", "legal", "Attorney comments", "2027-01-06", "2027-01-27", "exp. Jan 27", "21d"),
      expTodo("legal2", "legal", "Healthcare lease review", "2027-01-27", "2027-02-06", "exp. Feb 6", "10d"),
      expTodo("legal3", "legal", "TI scope and bids", "2027-02-06", "2027-02-20", "exp. Feb 20", "14d"),
    ],
  },
  {
    id: "closing",
    name: "Closing",
    count: "0 of 6",
    bar: phaseBar("closing", "2027-02-20", "2027-03-29"),
    startsFolded: false,
    rows: [
      expTodo("closing0", "closing", "Executed lease", "2027-02-20", "2027-03-06", "exp. Mar 6", "14d"),
      expTodo("closing1", "closing", "Commencement letter", "2027-03-06", "2027-03-16", "exp. Mar 16", "10d"),
      dateRow("comm-date", "closing", "Lease commencement", "2027-03-22", "proposed", "Mar 22"),
      dateRow("sign-exp", "closing", "Lease signed", "2027-03-06", "expected", "exp. Mar 6"),
      { id: "closing-wait", kind: "todo", phase: "closing", name: "Move-in", state: "waiting" } satisfies TimelineRow,
    ],
  },
];

// Only workflow to-do order plus LOI expiry and lease commencement among critical dates get arrows.
const LINKS: readonly TimelineLink[] = [
  { kind: "workflow", from: "rep", to: "req" },
  { kind: "workflow", from: "req", to: "survey" },
  { kind: "workflow", from: "survey", to: "tours" },
  { kind: "workflow", from: "tours", to: "loi" },
  { kind: "workflow", from: "loi", to: "terms" },
  { kind: "deadline", from: "terms", to: "loi-expiry", atRisk: true },
  { kind: "workflow", from: "terms", to: "agreed" },
  { kind: "workflow", from: "agreed", to: "legal0" },
  { kind: "workflow", from: "legal0", to: "legal1" },
  { kind: "workflow", from: "legal1", to: "legal2" },
  { kind: "workflow", from: "legal2", to: "legal3" },
  { kind: "workflow", from: "legal3", to: "closing0" },
  { kind: "workflow", from: "closing0", to: "closing1" },
  { kind: "deadline", from: "closing1", to: "comm-date" },
  { kind: "workflow", from: "closing1", to: "closing-wait" },
];

const CHART: TimelineProps = {
  foldKey: "deal-synthetic",
  today: "2026-11-25",
  from: "2026-09-28",
  to: "2027-04-05",
  groups: GROUPS,
  links: LINKS,
};
const MS_PER_DAY = 86_400_000;
const dayIndex = (iso: string) => (Date.parse(`${iso}T00:00:00Z`) - Date.parse(`${CHART.from}T00:00:00Z`)) / MS_PER_DAY;

async function open(t: TestContext, { width = 1440, height = 900 } = {}) {
  const read = (path: string) => readFile(new URL(`../${path}`, import.meta.url), "utf8");
  const routes = new Map<string, Descriptor>(
    [...(await uiAssets(read))].map(([path, body]) => [`/${path}`, { body, contentType: "text/javascript" }]),
  );
  for (const css of ["css/tokens.css", "css/timeline.css"])
    routes.set(`/${css}`, { body: await read(css), contentType: "text/css" });
  routes.set("/", {
    contentType: "text/html",
    body: '<!doctype html><html data-theme="dark"><head><link rel="stylesheet" href="/css/tokens.css"><link rel="stylesheet" href="/css/timeline.css"><style>body{margin:0;background:var(--ground)}#host{height:100dvh;padding:8px;box-sizing:border-box}</style></head><body><main id="host"></main></body></html>',
  });
  const server = await startFixture({ routes });
  t.after(() => server.close());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height } });
  const mount = (chart: TimelineProps) =>
    page.evaluate(async (chart) => {
      const { mountTimeline } = await import("/js/ui-timeline.generated.js");
      const host = document.querySelector<HTMLElement>("#host");
      if (!host) throw Error("The page has no host");
      mountTimeline(host, chart);
    }, chart);
  await page.goto(server.origin);
  await mount(CHART);
  return { page, mount, scroller: page.locator(".timeline-scroll") };
}

async function box(locator: Locator) {
  const found = await locator.boundingBox();
  assert.ok(found, "the element is on screen");
  return found;
}
const frames = (page: Page) =>
  page.evaluate(() => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))));
const dayWidth = async (page: Page) => Number(await page.locator(".timeline").getAttribute("data-day-width"));

test("the list column and date header stay put while the chart scrolls both ways, and the page itself does not scroll", async (t) => {
  const { page, scroller } = await open(t, { width: 1280, height: 640 });
  await scroller.evaluate((n) => n.scrollTo({ left: 900, top: 60 }));
  const view = await box(scroller);
  assert.equal((await box(page.locator(".timeline-head"))).y, view.y);
  const visibleRow = page.locator('[data-row="legal2"] .timeline-label');
  assert.equal((await box(visibleRow)).x, view.x);
  assert.equal(
    (await box(page.locator(".timeline-list-fill"))).x,
    view.x,
    "the list column runs on below the last row",
  );
  assert.deepEqual(await scroller.evaluate((n) => [n.scrollLeft, n.scrollTop]), [900, 60]);
  assert.equal(await page.evaluate(() => document.documentElement.scrollHeight <= innerHeight), true);
});

test("Day, Week and Month change how wide a day is and keep the middle of the view in place", async (t) => {
  const { page, scroller } = await open(t);
  const middle = () =>
    scroller.evaluate((n) => {
      const list = n.querySelector<HTMLElement>(".timeline-corner")?.offsetWidth ?? 0;
      const px = Number(n.closest<HTMLElement>(".timeline")?.dataset.dayWidth);
      return (n.scrollLeft + (n.clientWidth - list) / 2) / px;
    });
  const ticks = () =>
    page
      .locator(".timeline-date")
      .evaluateAll((ns) => ns.slice(0, 2).map((n) => (n instanceof HTMLElement ? n.offsetLeft : Number.NaN)));
  const zoom = (name: string) => page.getByRole("group", { name: "Zoom" }).getByRole("button", { name, exact: true });
  const zooms: [string, number, number][] = [
    ["Day", 28, 28],
    ["Week", 12, 12 * 7],
    ["Month", 4, 4 * 31],
  ];
  for (const [name, px, gap] of zooms) {
    const before = await middle();
    await zoom(name).click();
    assert.equal(await zoom(name).getAttribute("aria-pressed"), "true");
    assert.equal(await dayWidth(page), px);
    const [a, b] = await ticks();
    assert.ok(a !== undefined && b !== undefined, `${name} has ticks`);
    assert.ok(Math.abs(b - a - gap) <= 4 * 3, `${name} ticks ${b - a}px apart`);
    const fits = await scroller.evaluate((n) => n.scrollWidth <= n.clientWidth);
    if (!fits) assert.ok(Math.abs((await middle()) - before) < 1, `${name} keeps the middle day`);
  }
});

test("weekends are shaded across Saturday and Sunday", async (t) => {
  const { page } = await open(t);
  const px = await dayWidth(page);
  const shaded = await page
    .locator(".timeline-weekend")
    .evaluateAll((ns) =>
      ns.map((n) => (n instanceof HTMLElement ? { left: n.offsetLeft, width: n.offsetWidth } : null)),
    );
  assert.ok(shaded.length >= 26);
  for (const weekend of shaded) {
    assert.ok(weekend);
    const { left, width } = weekend;
    assert.equal(width, 2 * px);
    assert.equal(new Date(Date.parse(`${CHART.from}T00:00:00Z`) + (left / px) * MS_PER_DAY).getUTCDay(), 6);
  }
});

test("the Today pill and line sit on today, and Today brings them back into view", async (t) => {
  const { page, scroller } = await open(t);
  const px = await dayWidth(page);
  const line = page.locator(".timeline-now");
  const center = async (l: Locator) => {
    const b = await box(l);
    return b.x + b.width / 2;
  };
  assert.equal(
    await line.evaluate((n) => (n instanceof HTMLElement ? n.offsetLeft + n.offsetWidth / 2 : Number.NaN)),
    (dayIndex(CHART.today) + 0.5) * px,
  );
  assert.ok(Math.abs((await center(page.locator(".timeline-today"))) - (await center(line))) < 1);
  const inView = async () => {
    const v = await box(scroller);
    const list = await page.locator(".timeline-corner").evaluate((n) => (n instanceof HTMLElement ? n.offsetWidth : 0));
    const x = await center(line);
    return x > v.x + list && x < v.x + v.width;
  };
  assert.equal(await inView(), true, "the chart opens on today");
  await scroller.evaluate((n) => n.scrollTo({ left: n.scrollWidth }));
  assert.equal(await inView(), false);
  await page.getByRole("button", { name: "Today" }).click();
  assert.equal(await inView(), true);
});

test("groups fold from where they start and the fold is remembered on the device", async (t) => {
  const { page, mount } = await open(t);
  const rows = (id: string) =>
    page
      .locator(`[data-group="${id}"] ~ [data-row]`)
      .evaluateAll((ns) => ns.map((n) => (n instanceof HTMLElement ? n.dataset.row : undefined)));
  const group = (id: string) => page.locator(`[data-group="${id}"] button`);
  assert.equal(await group("research").getAttribute("aria-expanded"), "false");
  assert.equal(await page.locator('[data-row="rep"]').count(), 0);
  assert.equal(await group("neg").getAttribute("aria-expanded"), "true");
  await group("research").click();
  await group("neg").click();
  assert.equal(await page.locator('[data-row="rep"]').count(), 1);
  assert.equal(await page.locator('[data-row="loi"]').count(), 0);
  await page.reload();
  await mount(CHART);
  assert.equal(await group("research").getAttribute("aria-expanded"), "true");
  assert.equal(await group("neg").getAttribute("aria-expanded"), "false");
  await page.reload();
  await mount({ ...CHART, foldKey: "another-deal" });
  assert.equal(await group("research").getAttribute("aria-expanded"), "false");
  assert.ok((await rows("neg")).includes("loi"));
});

test("no date label sits under the Today pill at any zoom", async (t) => {
  const { page } = await open(t);
  for (const name of ["Day", "Week", "Month"]) {
    await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name, exact: true }).click();
    await page.getByRole("button", { name: "Today" }).click();
    const pill = await box(page.locator(".timeline-today"));
    const dates = await page.locator(".timeline-date").evaluateAll((ns) => ns.map((n) => n.getBoundingClientRect()));
    assert.ok(dates.length > 0, `${name} still has date labels`);
    for (const d of dates)
      assert.ok(d.right <= pill.x || d.left >= pill.x + pill.width, `${name}: a label at ${d.left} touches the pill`);
  }
});

test("a month's name stays at the left of the dates while the month is in view", async (t) => {
  const { page, scroller } = await open(t);
  await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name: "Day", exact: true }).click();
  const view = await box(scroller);
  const list = await box(page.locator(".timeline-corner"));
  const px = await dayWidth(page);
  const november = (dayIndex("2026-11-01") + 10) * px;
  await scroller.evaluate((n, left) => n.scrollTo({ left }), november);
  const name = await box(page.locator(".timeline-month", { hasText: "November" }).locator("span"));
  assert.ok(Math.abs(name.x - (view.x + list.width)) < 1, `the name sits at ${name.x}, beside the list column`);
});

test("the chart is a labelled region, its dates are hidden from screen readers but still told, and groups say what they control", async (t) => {
  const { page } = await open(t);
  const region = page.getByRole("region", { name: "Timeline" });
  assert.equal(await region.count(), 1);
  assert.equal(await page.locator(".timeline-dates").getAttribute("aria-hidden"), "true");
  assert.match((await page.locator(".timeline-sr").textContent()) ?? "", /2026-09-28 to 2027-04-05.*2026-11-25/);
  const controls = await page.locator('[data-group="neg"] button').getAttribute("aria-controls");
  assert.ok(controls);
  for (const id of controls.split(" ")) assert.equal(await page.locator(`[id="${id}"]`).count(), 1);
  assert.equal(await page.locator('[data-group="research"] button').getAttribute("aria-controls"), null);
});

test("the scrollbar shows only while the chart is being scrolled", async (t) => {
  const { scroller } = await open(t);
  assert.equal(await scroller.getAttribute("data-scrolling"), null);
  const shownWhileScrolling = await scroller.evaluate(
    (n) =>
      new Promise<boolean>((done) => {
        let shown = false;
        n.addEventListener("scroll", () => {
          shown = n.hasAttribute("data-scrolling");
        });
        n.addEventListener("scrollend", () => done(shown));
        n.scrollBy({ left: 40 });
      }),
  );
  assert.equal(shownWhileScrolling, true);
  assert.equal(await scroller.getAttribute("data-scrolling"), null);
});

test("to-do bars, step pills, diamonds and phase bars draw at their days with matching left-list marks", async (t) => {
  const { page } = await open(t);
  const px = await dayWidth(page);
  const nowLine = await box(page.locator(".timeline-now"));
  const nowCenter = nowLine.x + nowLine.width / 2;

  // Finished, in-progress (spent fill ends on Today), expected (dashed) and waiting (no bar) to-dos.
  assert.equal(await page.locator('[data-row="loi"] [data-mark="todo-done"]').count(), 1);
  assert.equal(await page.locator('[data-row="loi"] .timeline-glyph-check').count(), 1);
  const currentBar = await box(page.locator('[data-row="terms"] [data-mark="todo-current"]'));
  const currentFill = await box(page.locator('[data-row="terms"] .timeline-bar-fill'));
  assert.equal(Math.round(currentBar.width), 21 * px);
  assert.ok(Math.abs(currentFill.x + currentFill.width - nowCenter) < 1.5, "in-progress fill stops at Today");
  assert.equal(await page.locator('[data-row="terms"] .timeline-bar-meta').textContent(), "day 9 of 21");
  assert.equal(await page.locator('[data-row="terms"] [data-ring="current"]').count(), 1);
  const expectedStyle = await page
    .locator('[data-row="agreed"] [data-mark="todo-expected"]')
    .evaluate((n) => getComputedStyle(n).outlineStyle);
  assert.equal(expectedStyle, "dashed");
  assert.equal(await page.locator('[data-row="agreed"] .timeline-alert').textContent(), "!");
  assert.equal(await page.locator('[data-row="closing-wait"] .timeline-bar').count(), 0);
  assert.equal(await page.locator('[data-row="closing-wait"] .timeline-when').textContent(), "no date yet");

  // Step pills are thinner than to-do bars, carry partner initials in the list, and mark late steps red.
  const latePill = await box(page.locator('[data-row="late-step"] [data-mark="step-late"]'));
  assert.ok(latePill.height < currentBar.height, "step pills are thinner than to-do bars");
  assert.equal(await page.locator('[data-row="late-step"] .timeline-owner').textContent(), "D");
  assert.equal(await page.locator('[data-row="late-step"] .timeline-owner').getAttribute("aria-label"), "Dell");
  assert.equal(await page.locator('[data-row="late-step"] .timeline-alert').textContent(), "!");
  assert.equal(await page.locator('[data-row="counter-done"]').getAttribute("data-quiet"), "");

  // Milestone diamonds sit centered on their day in confirmed, proposed and expected forms.
  const spaceDiamond = await box(page.locator('[data-row="space-held"] [data-mark="date-confirmed"]'));
  const spaceCenter = spaceDiamond.x + spaceDiamond.width / 2;
  assert.ok(Math.abs(spaceCenter - (nowCenter + 5 * px)) < 1.5, "diamond centers on its day");
  assert.match((await page.locator('[data-row="space-held"] .timeline-diamond-detail').textContent()) ?? "", /at risk/);
  assert.equal(await page.locator('[data-row="comm-date"] [data-mark="date-proposed"]').count(), 1);
  assert.equal(await page.locator('[data-row="sign-exp"] [data-mark="date-expected"]').count(), 1);

  // Phase bars fill past phases completely, stop at Today on the current phase, and leave future phases unspent.
  assert.equal(await page.locator('[data-group="pending"] button').count(), 0, "empty phase is not a fold button");
  const siteBar = await box(page.locator('[data-group="site"] .timeline-phase-bar'));
  const siteSpent = await box(page.locator('[data-group="site"] .timeline-phase-spent'));
  assert.ok(Math.abs(siteSpent.width - siteBar.width) < 1);
  const negSpent = await box(page.locator('[data-group="neg"] .timeline-phase-spent'));
  assert.ok(Math.abs(negSpent.x + negSpent.width - nowCenter) < 1.5, "current phase bar fill stops at Today");
  assert.equal(await page.locator('[data-group="legal"] .timeline-phase-spent').count(), 0);
});

test("bar labels sit inside wide bars without colliding with metadata and move beside narrow bars across zooms", async (t) => {
  const { page } = await open(t);
  const termsBar = page.locator('[data-row="terms"] .timeline-bar');
  const termsBox = await box(termsBar);
  const termsName = await box(termsBar.locator(".timeline-bar-name"));
  const termsMeta = await box(termsBar.locator(".timeline-bar-meta"));
  assert.equal(await termsBar.getAttribute("data-label-pos"), "inside");
  assert.ok(termsName.x >= termsBox.x && termsName.x + termsName.width <= termsMeta.x + 1);

  const loiBar = page.locator('[data-row="loi"] .timeline-bar');
  const loiBox = await box(loiBar);
  const loiName = await box(loiBar.locator(".timeline-bar-name"));
  assert.equal(await loiBar.getAttribute("data-label-pos"), "beside");
  assert.ok(loiName.x >= loiBox.x + loiBox.width, "beside label starts past the bar's right edge");

  await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name: "Day", exact: true }).click();
  assert.equal(await loiBar.getAttribute("data-label-pos"), "inside");
  await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name: "Month", exact: true }).click();
  assert.equal(await termsBar.getAttribute("data-label-pos"), "beside");
});

test("stale, unrecorded and undated rows render cleanly without gradients, and both themes keep four or fewer text sizes", async (t) => {
  const { page, mount } = await open(t, { width: 1280, height: 640 });
  await mount({
    ...CHART,
    foldKey: "edge-states",
    groups: [
      {
        id: "edge",
        name: "Negotiating",
        count: "0 of 2",
        startsFolded: false,
        rows: [
          { id: "old", kind: "todo", phase: "negotiation", name: "LOIs sent", state: "unrecorded" },
          {
            id: "stale",
            kind: "todo",
            phase: "negotiation",
            name: "Terms comparison",
            state: "stale",
            start: "2026-10-10",
            when: "46 days so far",
          },
          {
            id: "nodate",
            kind: "step",
            phase: "negotiation",
            owner: "Joe",
            name: "Confirm parking ratio",
            state: "undated",
            start: "2026-11-20",
          },
        ],
      },
    ],
  });
  assert.equal(await page.locator('[data-row="old"] .timeline-bar').count(), 0);
  assert.equal(await page.locator('[data-row="old"] .timeline-when').textContent(), "not recorded");
  assert.equal(await page.locator('[data-row="stale"] [data-mark="todo-stale"]').count(), 1);
  assert.equal(await page.locator('[data-row="stale"] .timeline-when').getAttribute("data-tone"), "soon");
  assert.equal(await page.locator('[data-row="nodate"] [data-mark="step-undated"]').count(), 1);
  assert.equal(await page.locator('[data-row="nodate"] .timeline-when').textContent(), "No date");

  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const audit = await page.evaluate(() => {
      const sizes = new Set<string>();
      let gradient = false;
      for (const el of document.querySelectorAll(".timeline, .timeline *")) {
        const s = getComputedStyle(el);
        if (el.textContent?.trim()) sizes.add(s.fontSize);
        if (s.backgroundImage.includes("gradient") || s.maskImage.includes("gradient")) gradient = true;
      }
      return {
        sizes: [...sizes],
        gradient,
        bodySize: getComputedStyle(document.querySelector(".timeline") ?? document.body).fontSize,
        fitsWindow: document.documentElement.scrollHeight <= innerHeight,
      };
    });
    assert.equal(audit.gradient, false, `${theme} uses no gradients`);
    assert.equal(audit.bodySize, "14px", `${theme} body text is 14px`);
    assert.ok(audit.sizes.length <= 4, `${theme} uses at most four text sizes: ${audit.sizes.join(", ")}`);
    assert.equal(audit.fitsWindow, true, `${theme} fits in one window`);
  }
});

test("the Today line is drawn under every bar and label, never through their text", async (t) => {
  const { page } = await open(t);
  const stack = await page.evaluate(() => {
    const z = (selector: string) => {
      const found = document.querySelector(selector);
      if (!found) throw Error(`No ${selector}`);
      return Number(getComputedStyle(found).zIndex);
    };
    return {
      line: z(".timeline-now"),
      bar: z(".timeline-bar"),
      diamondLabel: z(".timeline-diamond-label"),
    };
  });
  assert.ok(stack.line < stack.bar, "the line is under bars and their names");
  assert.ok(stack.line < stack.diamondLabel, "the line is under diamond labels");
});

test("at phone width a step keeps its owner's initial in the list", async (t) => {
  const { page } = await open(t, { width: 390, height: 800 });
  const owner = page.locator('[data-row="late-step"] .timeline-owner');
  assert.equal(await owner.textContent(), "D");
  assert.notEqual(await owner.evaluate((n) => getComputedStyle(n).display), "none");
  assert.ok((await box(owner)).width > 0);
});

test("a bar's name is whole inside it or beside it, never cut short, at every zoom", async (t) => {
  const { page } = await open(t);
  for (const zoom of ["Day", "Week", "Month"]) {
    await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name: zoom, exact: true }).click();
    const cut = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>(".timeline-bar")]
        .filter((bar) => bar.dataset.labelPos === "inside")
        .map((bar) => bar.querySelector<HTMLElement>(".timeline-bar-name"))
        .filter((name): name is HTMLElement => name !== null && name.scrollWidth > name.clientWidth)
        .map((name) => name.textContent),
    );
    assert.deepEqual(cut, [], `${zoom}: no inside name is truncated`);
    const bars = await page.evaluate(
      () =>
        [...document.querySelectorAll<HTMLElement>(".timeline-bar")].filter(
          (bar) => bar.dataset.labelPos === "inside" && bar.querySelector(".timeline-bar-name")?.scrollWidth,
        ).length,
    );
    if (zoom !== "Month") assert.ok(bars > 0, `${zoom}: some names still fit inside their bars`);
  }
  const tours = page.locator('[data-row="tours"] .timeline-bar');
  assert.equal(await tours.getAttribute("data-label-pos"), "beside", "a name wider than its Week bar goes beside it");
});

test("a finished step pill stands clearly apart from the page in both themes, with no gradient", async (t) => {
  const { page } = await open(t);
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const contrast = await page.evaluate(() => {
      const paint = (color: string) => {
        const context = document.createElement("canvas").getContext("2d");
        if (!context) throw Error("no canvas");
        context.fillStyle = color;
        context.fillRect(0, 0, 1, 1);
        return [...context.getImageData(0, 0, 1, 1).data.slice(0, 3)].map((c) => {
          const v = c / 255;
          return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
        });
      };
      const luminance = ([r = 0, g = 0, b = 0]: number[]) => 0.2126 * r + 0.7152 * g + 0.0722 * b;
      const pill = document.querySelector('[data-mark="step-done"]');
      if (!pill) throw Error("no finished step");
      const style = getComputedStyle(pill);
      const [hi, lo] = [
        luminance(paint(style.backgroundColor)),
        luminance(paint(getComputedStyle(document.body).backgroundColor)),
      ].sort((a, b) => (b ?? 0) - (a ?? 0));
      return { ratio: ((hi ?? 0) + 0.05) / ((lo ?? 0) + 0.05), image: style.backgroundImage };
    });
    assert.equal(contrast.image, "none");
    assert.ok(contrast.ratio >= 1.5, `${theme}: pill contrast ${contrast.ratio.toFixed(2)} against the page`);
  }
});

test("a label beside a bar that starts under the list column never shows its tail past the list edge", async (t) => {
  const { page, scroller } = await open(t);
  await page.getByRole("button", { name: /Research/ }).click();
  const leaks = async () =>
    page.evaluate(() => {
      const edge = document.querySelector(".timeline-corner")?.getBoundingClientRect().right ?? 0;
      return [...document.querySelectorAll<HTMLElement>(".timeline-bar-name, .timeline-diamond-label")]
        .filter((label) => label.closest('[data-label-pos="inside"]') === null)
        .filter((label) => getComputedStyle(label).visibility === "visible")
        .filter((label) => {
          const { left, right } = label.getBoundingClientRect();
          return left + parseFloat(getComputedStyle(label).paddingLeft) < edge && right > edge;
        })
        .map((label) => label.textContent);
    });
  assert.deepEqual(await leaks(), []);
  await scroller.evaluate((n) => n.scrollTo({ left: 0 }));
  await frames(page);
  assert.deepEqual(await leaks(), []);
  await scroller.evaluate((n) => n.scrollTo({ left: 230 }));
  await frames(page);
  assert.deepEqual(await leaks(), []);
});

test("arrows draw workflow and allowed critical-date links with right-angle routes, back routes for at-risk links, and mask cutouts around labels", async (t) => {
  const { page } = await open(t);
  const paths = await page.locator(".timeline-link").evaluateAll((ns) =>
    ns.map((n) => ({
      from: n.getAttribute("data-from"),
      to: n.getAttribute("data-to"),
      kind: n.getAttribute("data-link-kind"),
      atRisk: n.hasAttribute("data-at-risk"),
      backRoute: n.hasAttribute("data-back-route"),
      d: n.getAttribute("d") ?? "",
    })),
  );
  // Research starts folded and closing-wait has no mark, so 12 of the 15 links draw.
  assert.equal(paths.length, 12);
  assert.equal(
    paths.some((p) => p.from === "rep" || p.to === "closing-wait" || p.to === "space-held"),
    false,
    "folded, dayless and non-gated critical date rows get no arrow",
  );
  const forward = paths.find((p) => p.from === "closing1" && p.to === "comm-date");
  assert.ok(forward, "Lease commencement gets a forward deadline arrow");
  assert.equal(forward.kind, "deadline");
  assert.equal(forward.atRisk, false);
  assert.equal(forward.backRoute, false);
  assert.match(forward.d, /Q.*M[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+L[\d.-]+ [\d.-]+$/);

  const atRisk = paths.find((p) => p.from === "terms" && p.to === "loi-expiry");
  assert.ok(atRisk, "LOI expiry gets an at-risk back-route arrow from Terms comparison");
  assert.equal(atRisk.atRisk, true);
  assert.equal(atRisk.backRoute, true);

  // Unfolding Research brings its two workflow arrows onto the chart.
  await page.getByRole("button", { name: /Research/ }).click();
  assert.equal(await page.locator('.timeline-link[data-from="rep"][data-to="req"]').count(), 1);
  assert.equal(await page.locator('.timeline-link[data-from="req"][data-to="survey"]').count(), 1);

  // Mask cutouts cover beside-bar and diamond labels in track coordinates without gradients.
  const maskCheck = await page.evaluate(() => {
    const svg = document.querySelector(".timeline-links");
    const svgBox = svg?.getBoundingClientRect();
    if (!svg || !svgBox) throw Error("no arrows svg");
    const cutouts = new Map(
      [...svg.querySelectorAll("mask rect[data-cutout]")].map((r) => [
        r.getAttribute("data-cutout") ?? "",
        { x: Number(r.getAttribute("x")), width: Number(r.getAttribute("width")) },
      ]),
    );
    const missing: string[] = [];
    for (const row of document.querySelectorAll<HTMLElement>("[data-row]")) {
      const id = row.dataset.row ?? "";
      const label = row.querySelector<HTMLElement>(
        '.timeline-bar[data-label-pos="beside"] .timeline-bar-name, .timeline-diamond-label',
      );
      if (!label) continue;
      const c = cutouts.get(id);
      const box = label.getBoundingClientRect();
      const pad = parseFloat(getComputedStyle(label).paddingLeft);
      const textLeft = box.left + pad - svgBox.left;
      const textRight = box.right - svgBox.left;
      if (!c || c.x > textLeft || c.x + c.width < textRight - 1) missing.push(id);
    }
    return { missing, count: cutouts.size };
  });
  assert.ok(maskCheck.count > 0);
  assert.deepEqual(maskCheck.missing, [], "every beside and diamond label is covered by a mask cutout");
});

test("hovering a bar brightens its arrows, fades the rest, and shows a note with dates and source in both themes", async (t) => {
  const { page } = await open(t);
  const termsBar = page.locator('[data-row="terms"] .timeline-bar');
  await termsBar.hover();
  assert.equal(await page.locator(".timeline-links").getAttribute("data-dim"), "");
  assert.equal(
    await page.locator('.timeline-link[data-from="terms"][data-to="loi-expiry"]').getAttribute("data-active"),
    "",
  );
  assert.equal(
    await page.locator('.timeline-link[data-from="terms"][data-to="agreed"]').getAttribute("data-active"),
    "",
  );
  assert.equal(await page.locator('.timeline-link[data-from="loi"][data-to="terms"]').getAttribute("data-active"), "");
  assert.equal(
    await page.locator('.timeline-link[data-from="survey"][data-to="tours"]').getAttribute("data-active"),
    null,
  );

  const tip = page.getByRole("tooltip");
  assert.equal(await tip.count(), 1);
  const tipText = (await tip.textContent()) ?? "";
  assert.match(tipText, /Terms comparison/);
  assert.match(tipText, /Nov 16 to Dec 7/);
  assert.match(tipText, /Expected 4 days after LOI expiry/);

  // Hovering an at-risk diamond names the to-do expected after it.
  await page.locator('[data-row="loi-expiry"] .timeline-diamond').hover();
  const dateTip = (await tip.textContent()) ?? "";
  assert.match(dateTip, /LOI expiry/);
  assert.match(dateTip, /Thu, Dec 3/);
  assert.match(dateTip, /Terms comparison is expected 4 days after it/);

  // Hovering the top visible bar flips the note below so it never clips under the sticky header.
  await page.locator('[data-row="survey"] .timeline-bar').hover();
  const surveyTip = await box(tip);
  const head = await box(page.locator(".timeline-head"));
  assert.ok(surveyTip.y >= head.y + head.height - 1, "top-row hover note stays clear of the sticky date header");

  // No gradients and at most four text sizes even with arrows and hover note visible.
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    const audit = await page.evaluate(() => {
      const sizes = new Set<string>();
      let gradient = false;
      for (const el of document.querySelectorAll(".timeline, .timeline *")) {
        const s = getComputedStyle(el);
        if (el.textContent?.trim()) sizes.add(s.fontSize);
        if (s.backgroundImage.includes("gradient") || s.maskImage.includes("gradient")) gradient = true;
      }
      return { sizes: [...sizes], gradient };
    });
    assert.equal(audit.gradient, false, `${theme} uses no gradients with arrows and hover note`);
    assert.ok(audit.sizes.length <= 4, `${theme} keeps <=4 text sizes: ${audit.sizes.join(", ")}`);
  }

  // Moving away clears dim state and removes the hover note; keyboard focus + Escape works too.
  await page.locator(".timeline-tools").hover();
  assert.equal(await page.locator(".timeline-links").getAttribute("data-dim"), null);
  assert.equal(await tip.count(), 0);
  await termsBar.focus();
  assert.equal(await tip.count(), 1);
  await page.keyboard.press("Escape");
  assert.equal(await tip.count(), 0);
});

test("hover notes wrap inside the visible track at 390px and clamp bold titles inside right-edge desktop viewports", async (t) => {
  const { page, scroller } = await open(t, { width: 390, height: 844 });
  const tip = page.getByRole("tooltip");
  for (const theme of ["dark", "light"]) {
    await page.evaluate((value) => {
      document.documentElement.dataset.theme = value;
    }, theme);
    for (const zoom of ["Day", "Week", "Month"]) {
      await page.getByRole("group", { name: "Zoom" }).getByRole("button", { name: zoom, exact: true }).click();
      for (const id of ["loi-expiry", "closing1", "terms"]) {
        const target = page.locator(`[data-row="${id}"] .timeline-date-mark, [data-row="${id}"] .timeline-bar`);
        await target.focus();
        await frames(page);
        const view = await box(scroller);
        const corner = await box(page.locator(".timeline-corner"));
        const tipBox = await box(tip);
        assert.ok(
          tipBox.x >= corner.x + corner.width - 0.5,
          `390px ${theme} ${zoom} ${id}: note stays right of list (${tipBox.x} vs ${corner.x + corner.width})`,
        );
        assert.ok(
          tipBox.x + tipBox.width <= view.x + view.width + 0.5,
          `390px ${theme} ${zoom} ${id}: note stays inside right edge (${tipBox.x + tipBox.width} vs ${view.x + view.width})`,
        );
      }
    }
  }

  for (const viewport of [
    { width: 1280, height: 640 },
    { width: 1440, height: 900 },
  ]) {
    const desktop = await open(t, viewport);
    const wideTitle = "Comprehensive healthcare lease review and compliance sign-off";
    await desktop.mount({
      ...CHART,
      foldKey: `right-edge-${viewport.width}`,
      groups: [
        {
          id: "edge",
          name: "Legal",
          count: "0 of 1",
          startsFolded: false,
          rows: [expTodo("wide-bold", "legal", wideTitle, "2027-02-20", "2027-03-06", "exp. Mar 6", "14d")],
        },
      ],
      links: [],
    });
    const bar = desktop.page.locator('[data-row="wide-bold"] .timeline-bar');
    const barOffset = await bar.evaluate((n) => (n instanceof HTMLElement ? n.offsetLeft : 0));
    await desktop.scroller.evaluate((n, left) => {
      const list = n.querySelector<HTMLElement>(".timeline-corner")?.offsetWidth ?? 0;
      n.scrollTo({ left: Math.max(0, left - (n.clientWidth - list) + 40) });
    }, barOffset);
    await bar.focus();
    await frames(desktop.page);
    const view = await box(desktop.scroller);
    const tipBox = await box(desktop.page.getByRole("tooltip"));
    assert.ok(
      tipBox.x + tipBox.width <= view.x + view.width + 0.5,
      `${viewport.width}px bold title note stays inside right edge (${tipBox.x + tipBox.width} vs ${view.x + view.width})`,
    );
  }
});

test("a diamond mark and its label form one continuous hover target with no dead gap", async (t) => {
  const { page } = await open(t);
  const mark = page.locator('[data-row="loi-expiry"] .timeline-date-mark');
  const diamond = page.locator('[data-row="loi-expiry"] .timeline-diamond');
  const label = page.locator('[data-row="loi-expiry"] .timeline-diamond-label');
  const markBox = await box(mark);
  const diamondBox = await box(diamond);
  const labelBox = await box(label);
  assert.ok(markBox.width >= labelBox.x + labelBox.width - diamondBox.x - 2, "button spans diamond and label");

  const midY = diamondBox.y + diamondBox.height / 2;
  const gapX = (diamondBox.x + diamondBox.width + labelBox.x) / 2;
  const tip = page.getByRole("tooltip");

  await page.mouse.move(diamondBox.x + diamondBox.width / 2, midY);
  assert.equal(await tip.getAttribute("data-for"), "loi-expiry");
  assert.equal(await page.locator(".timeline-links").getAttribute("data-dim"), "");

  await page.mouse.move(gapX, midY);
  assert.equal(await tip.getAttribute("data-for"), "loi-expiry", "hover stays active across diamond-to-label gap");
  assert.equal(await page.locator(".timeline-links").getAttribute("data-dim"), "");

  await page.mouse.move(labelBox.x + 12, midY);
  assert.equal(await tip.getAttribute("data-for"), "loi-expiry");

  await mark.focus();
  assert.equal(await mark.evaluate((n) => getComputedStyle(n).outlineStyle), "none", "focus ring stays on the diamond");
});

test("row metadata is computed once per visible row during layout and RowBox pairs each row kind with its spec", async (t) => {
  const { page } = await open(t);
  const result = await page.evaluate(async (baseChart) => {
    const { layoutTimeline, mountTimeline } = await import("/js/ui-timeline.generated.js");
    const start = Date.parse(`${baseChart.from}T00:00:00Z`) / 86_400_000;
    const now = Date.parse(`${baseChart.today}T00:00:00Z`) / 86_400_000;
    const layout = layoutTimeline(baseChart.groups, {}, 34, start, now, 12, (text) => text.length * 7);
    const describeBox = (box: RowBox | undefined) => {
      if (!box) return null;
      return box.kind === "date"
        ? { kind: box.kind, day: box.row.day, center: box.spec.center }
        : { kind: box.kind, mark: box.spec.mark, rowKind: box.row.kind };
    };
    const neg = layout.groups.find((g) => g.group.id === "neg");
    const sharedMeta = neg?.rows.every((entry) => !entry.box || entry.meta === entry.box.meta) ?? false;

    const host = document.createElement("div");
    host.style.height = "400px";
    document.body.append(host);
    const handle = mountTimeline(host, { ...baseChart, foldKey: "meta-dedupe" });
    await document.fonts?.ready;
    await new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done)));
    let visibleReads = 0;
    let foldedReads = 0;
    const countedRow = (id: string, onRead: () => void) => {
      const row = { id, kind: "todo" as const, phase: "closing" as const, name: "Move-in", state: "waiting" as const };
      Object.defineProperty(row, "when", {
        enumerable: true,
        get() {
          onRead();
          return "no date yet";
        },
      });
      return row;
    };
    handle.update({
      ...baseChart,
      foldKey: "meta-dedupe",
      groups: [
        {
          id: "folded",
          name: "Folded",
          startsFolded: true,
          rows: [
            countedRow("folded-wait", () => {
              foldedReads++;
            }),
          ],
        },
        {
          id: "open",
          name: "Open",
          startsFolded: false,
          rows: [
            countedRow("open-wait", () => {
              visibleReads++;
            }),
          ],
        },
      ],
      links: [],
    });
    handle.dispose();
    host.remove();
    return {
      visibleReads,
      foldedReads,
      sharedMeta,
      dateBox: describeBox(layout.boxes.get("loi-expiry")),
      barBox: describeBox(layout.boxes.get("terms")),
    };
  }, CHART);
  assert.equal(result.visibleReads, 1, "rowMeta reads visible row metadata once per render");
  assert.equal(result.foldedReads, 0, "folded rows skip rowMeta");
  assert.equal(result.sharedMeta, true, "each laid-out row reuses its box's RowMeta");
  assert.equal(result.dateBox?.kind, "date");
  assert.equal(result.dateBox?.day, "2026-12-03");
  assert.equal(result.barBox?.kind, "bar");
  assert.equal(result.barBox?.mark, "todo-current");
});
