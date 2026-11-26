import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test, { type TestContext } from "node:test";
import type { Locator, Page } from "playwright";
import { type Descriptor, startFixture } from "../scripts/fixture-http.mjs";
import { uiAssets } from "../scripts/ui-bundle.mjs";
import type { TimelineProps } from "../src/ui/timeline.tsx";
import { chromium } from "./browser-harness.mjs";

// A made-up lease deal's plan: phases folding over their to-dos.
const todo = (id: string, name: string, when: string) => ({ id, name, when });
const CHART: TimelineProps = {
  foldKey: "deal-synthetic",
  today: "2026-11-25",
  from: "2026-09-28",
  to: "2027-04-05",
  groups: [
    {
      id: "research",
      name: "Research",
      count: "2 of 2",
      startsFolded: true,
      rows: [todo("rep", "Representation agreement", "Oct 2"), todo("req", "Intake and requirements", "Oct 14")],
    },
    {
      id: "site",
      name: "Site Selection",
      count: "2 of 2",
      startsFolded: true,
      rows: [todo("survey", "Market survey", "Nov 1"), todo("tours", "Tours and tour notes", "Nov 10")],
    },
    {
      id: "neg",
      name: "Negotiating",
      count: "1 of 3",
      startsFolded: false,
      rows: [
        todo("loi", "LOIs sent", "Nov 16"),
        todo("terms", "Terms comparison", "exp. Dec 7"),
        todo("agreed", "Agreed business terms", "exp. Dec 27"),
      ],
    },
    {
      id: "legal",
      name: "Legal",
      count: "0 of 4",
      startsFolded: false,
      rows: ["Lease draft to attorney", "Attorney comments", "Healthcare lease review", "TI scope and bids"].map(
        (n, i) => todo(`legal${i}`, n, `exp. Jan ${6 + 7 * i}`),
      ),
    },
    {
      id: "closing",
      name: "Closing",
      count: "0 of 6",
      startsFolded: false,
      rows: [
        "Executed lease",
        "Commencement letter",
        "Executed comp",
        "Lease end recorded",
        "Move-in",
        "90-day check-in",
      ].map((n, i) => todo(`closing${i}`, n, `exp. Feb ${2 + 4 * i}`)),
    },
  ],
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
  await scroller.evaluate((n) => n.scrollTo({ left: 900, top: 80 }));
  const view = await box(scroller);
  assert.equal((await box(page.locator(".timeline-head"))).y, view.y);
  const visibleRow = page.locator('[data-row="legal2"] .timeline-label');
  assert.equal((await box(visibleRow)).x, view.x);
  assert.deepEqual(await scroller.evaluate((n) => [n.scrollLeft, n.scrollTop]), [900, 80]);
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

test("the chart fades out at the bottom without hiding its last row", async (t) => {
  const { page, scroller } = await open(t, { width: 1280, height: 640 });
  const view = await box(scroller);
  const fade = await box(page.locator(".timeline-fade"));
  assert.ok(Math.abs(fade.y + fade.height - (view.y + view.height)) < 1, "the fade sits on the bottom edge");
  await scroller.evaluate((n) => n.scrollTo({ top: n.scrollHeight }));
  assert.equal((await box(page.locator(".timeline-fade"))).y, fade.y, "the fade stays put while scrolling");
  const last = await box(page.locator('[data-row="closing5"]'));
  assert.ok(last.y + last.height <= fade.y + 1, "the last row ends above the fade");
});
