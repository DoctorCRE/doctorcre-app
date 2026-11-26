import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import { type Descriptor, startFixture } from "../scripts/fixture-http.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";
import type {
  TimelineDate,
  TimelineGroup,
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
      dateRow("loi-due", "negotiation", "LOI response due", "2026-12-10", "confirmed", "Dec 10"),
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
      dateRow("comm-date", "closing", "Lease commencement", "2027-03-22", "proposed", "Mar 22"),
      dateRow("sign-exp", "closing", "Lease signed", "2027-03-06", "expected", "exp. Mar 6"),
      { id: "closing-wait", kind: "todo", phase: "closing", name: "Move-in", state: "waiting" } satisfies TimelineRow,
    ],
  },
];

const CHART: TimelineProps = {
  foldKey: "deal-synthetic",
  today: "2026-11-25",
  from: "2026-09-28",
  to: "2027-04-05",
  groups: GROUPS,
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
