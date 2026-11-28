import type { TestContext } from "node:test";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import { chromium } from "../browser-harness.mjs";
import { ownedServer } from "../fixture-probe.ts";
import { directoryFixture, PAGE_SIZE, type VendorRoster } from "./vendor-directory.synthetic.mjs";
import { captureSurface, installSurfaceCapture, type SurfaceElement } from "./vendor-surface.ts";

const origin = "http://fixture.test";
const listPath = "/api/v1/business/vendors";
const localParams = new Set(["record", "relationship", "market"]);

type Address = ReturnType<typeof address>;
type ScreenRead = { navigation: number; query: string; readsList: boolean };
const pageReads = new WeakMap<Page, { urls: Address[]; navigation: number; previous?: ScreenRead }>();

function address(url: URL) {
  return { path: url.pathname, query: [...url.searchParams.entries()].sort() };
}

export function matchesVendorRequest(url: URL, path: string) {
  const wanted = address(new URL(path, origin));
  const actual = address(url);
  return actual.path === wanted.path && JSON.stringify(actual.query) === JSON.stringify(wanted.query);
}

function vendorListRequest(query: string) {
  return `${listPath}?contract=vendor-directory.v1${query ? `&${query}` : ""}`;
}

export async function holdVendorList(page: Page, query: string) {
  const matches = (url: URL) => matchesVendorRequest(url, vendorListRequest(query));
  const gate = Promise.withResolvers<void>();
  let requested = false;
  await page.route(
    matches,
    async (route) => {
      requested = true;
      await gate.promise;
      await route.fallback();
    },
    { times: 1 },
  );
  return {
    waitUntilHeld: () => expect.poll(() => requested, { message: `Holding Vendors list for ${query}` }).toBe(true),
    release: gate.resolve,
  };
}

export async function openVendors(
  t: TestContext,
  roster: VendorRoster,
  { width = 1440, height = 900, view = "/vendors", live = false, light = false, touch = false, holdQuery = "" } = {},
) {
  const server = await ownedServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({
    viewport: { width, height },
    colorScheme: light ? "light" : "dark",
    isMobile: touch,
  });
  if (light)
    await page.addInitScript(() =>
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" })),
    );
  await installSurfaceCapture(page);
  const listReads: Address[] = [];
  const reads = { urls: listReads, navigation: 0 };
  pageReads.set(page, reads);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    reads.navigation++;
    listReads.length = 0;
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === listPath) listReads.push(address(url));
  });
  await page.route("**/api/v1/business/**", (route) =>
    route.fulfill({ json: directoryFixture(route.request().url(), { roster }) }),
  );
  await page.route("**/mcp", (route) =>
    route.fulfill({
      json: {
        jsonrpc: "2.0",
        id: route.request().postDataJSON()?.id,
        result: { content: [{ type: "text", text: "{}" }] },
      },
    }),
  );
  if (live) {
    await page.route("**/auth/session", (route) =>
      route.fulfill({ json: { actor: { slug: "joe" }, csrf_token: "synthetic" } }),
    );
  }
  if (live || roster.markets.length) {
    const flags = [live && "data-clients-vendors-from-engine", roster.markets.length && "data-vendor-territory-tiles"]
      .filter(Boolean)
      .join(" ");
    await page.route(
      (url) => url.pathname === "/vendors",
      async (route) => {
        const response = await route.fetch();
        return route.fulfill({
          response,
          body: (await response.text()).replace("<html ", `<html ${flags} `),
        });
      },
    );
  }
  const heldList = holdQuery ? await holdVendorList(page, holdQuery) : undefined;
  const url = new URL(view, server.url);
  if (live) url.searchParams.set("mode", "live");
  await page.goto(url.href);
  return { page, heldList };
}

const relationships = [
  ["core", "Core"],
  ["established", "Established"],
  ["building", "Building"],
  ["prospective", "Prospective"],
  ["not_rated", "Not rated"],
  ["parked", "Parked"],
  ["avoid", "Avoid"],
] as const;

type Vendor = VendorRoster["rows"][number];

function relationshipRank(vendor: Vendor) {
  if (vendor.recorded_disposition === "avoid") return 6;
  if (vendor.recorded_disposition === "parked") return 5;
  return vendor.relationship_level === null ? 4 : 3 - vendor.relationship_level;
}

const element = (role: string, name?: string): SurfaceElement => (name ? { role, name } : { role });
const hidden = (role: string, name?: string): SurfaceElement => ({ ...element(role, name), hidden: true });
const text = (value: string): SurfaceElement => ({ text: value });
const button = (label: string, pressed?: boolean, count = ""): SurfaceElement => ({
  role: "button",
  name: count ? `${label} ${count}` : label,
  text: label,
  ...(pressed !== undefined && { pressed: String(pressed) }),
});

function tally(rows: Vendor[]) {
  return relationships.map(([key, label], rank) => ({
    key,
    label,
    count: rows.filter((row) => relationshipRank(row) === rank).length,
  }));
}

function tile(label: string, rows: Vendor[], phone: boolean): SurfaceElement[] {
  const quiet = rows.filter((row) => row.quiet).length;
  const mix = phone ? [] : tally(rows).filter(({ count }) => count > 0);
  const footer = quiet ? `${quiet} quiet` : "";
  const name = `${label}${rows.length}${mix.length ? ` ${mix.map(({ label, count }) => `${count} ${label}`).join(" ")}${footer ? " " : ""}` : ""}${footer}`;
  return [
    element("listitem", name),
    element("link", name),
    text(label),
    text(String(rows.length)),
    ...(!phone ? [element("list")] : []),
    ...mix.flatMap(({ label, count }) => [
      { role: "listitem", name: `${count} ${label}`, text: label },
      text(String(count)),
    ]),
    ...(footer ? [text(footer)] : []),
  ];
}

function rowSurface(
  row: Vendor,
  { phone, inCategory, cardOpen }: { phone: boolean; inCategory: boolean; cardOpen: boolean },
): SurfaceElement[] {
  const rank = relationshipRank(row);
  const relation = relationships[rank]?.[1] ?? "";
  const target = row.is_target && rank !== 6 ? "Want to meet" : "";
  const contacted = row.relationship.last_contacted_at;
  const date = contacted
    ? new Date(contacted).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" })
    : "";
  const days = date && row.quiet && row.quiet_days !== null ? `· ${row.quiet_days} days` : "";
  const lastContact = date ? [date, days].filter(Boolean).join(" ") : row.quiet ? "No contact yet" : "";
  const location = phone || cardOpen ? "" : `${row.city}, ${row.state}`;
  const category = phone || cardOpen || inCategory ? "" : row.recorded_category_label;
  const owner = phone ? "" : row.owner_label;
  const facts = [
    ["Relationship", relation],
    ["Category", category],
    ["Territory", row.territory],
    ["Location", location],
  ];
  const name =
    row.name +
    target +
    facts.map(([label, value]) => (value ? label + value : "")).join("") +
    (lastContact ? `Last contacted ${lastContact}` : "") +
    (owner ? `Owner: ${owner}` : "");
  return [
    element("listitem", name),
    element("link", name),
    text(row.name),
    ...(target ? [text(target)] : []),
    ...facts.flatMap(([, value]) => (value ? [text(value)] : [])),
    ...(lastContact
      ? [
          { ...(row.quiet && { quiet: true as const }), ...(!date ? text(lastContact) : days ? text(days) : {}) },
          ...(date ? [text(date)] : []),
        ].filter((part) => Object.keys(part).length)
      : []),
    ...(owner ? [text(owner)] : []),
  ];
}

function inMarket(row: Vendor, market: string) {
  if (!market) return true;
  if (market === "elsewhere") return row.territory !== null && row.markets.length === 0;
  if (market === "no_territory") return row.territory === null;
  return row.markets.some(({ id }) => id === market);
}

function territoryTiles(markets: VendorRoster["markets"], rows: Vendor[], selected: string) {
  const counts = [
    { id: "", label: "All territories", count: rows.length },
    ...markets
      .map(({ id, name }) => ({ id, label: name, count: rows.filter((row) => inMarket(row, id)).length }))
      .filter(({ count }) => count > 0),
    ...[
      ["elsewhere", "Elsewhere"],
      ["no_territory", "No territory"],
    ].map(([id = "", label = ""]) => ({
      id,
      label,
      count: rows.filter((row) => inMarket(row, id)).length,
    })),
  ];
  return [
    element("group", "Territories"),
    ...counts.flatMap(({ id, label, count }) => [
      { role: "button", name: label + count, pressed: String(id === selected) },
      text(label),
      text(String(count)),
    ]),
  ];
}

function tableControls(rows: Vendor[], counted: boolean, relation: string | null, quiet: boolean) {
  const counts = counted ? tally(rows).filter(({ key, count }) => count > 0 || key === relation) : [];
  const quietCount = counted ? String(rows.filter((row) => row.quiet).length) : "";
  return [
    element("group", "Show only"),
    ...counts.flatMap(({ key, label, count }) => [button(label, key === relation, String(count)), text(String(count))]),
    button("Quiet", quiet, quietCount),
    ...(quietCount ? [text(quietCount)] : []),
  ];
}

function listRequests(query: URLSearchParams, pages: number, markets: boolean) {
  const params = new URLSearchParams(query);
  for (const key of localParams) params.delete(key);
  params.delete("all");
  if (markets) params.set("markets", "true");
  return Array.from({ length: pages }, (_, i) => {
    if (i) params.set("page", String(i + 1));
    return address(new URL(vendorListRequest(params.toString()), origin));
  }).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
}

export function screenFor(
  roster: VendorRoster,
  {
    view = "/vendors",
    layout = "desktop",
    page = 1,
    loading = false,
    fromTile = false,
    meetings = false,
    live = false,
  }: {
    view?: string;
    layout?: "desktop" | "phone";
    page?: number;
    loading?: boolean;
    fromTile?: boolean;
    meetings?: boolean;
    live?: boolean;
  } = {},
) {
  const url = new URL(view, origin);
  const query = url.searchParams;
  const category = query.get("category");
  const noCategory = query.has("no_category");
  const inCategory = Boolean(category || noCategory);
  const search = query.get("q")?.toLowerCase() ?? "";
  const quiet = query.has("quiet");
  const sort = query.get("sort");
  const owner = query.get("owner");
  const showTiles = !inCategory && !search && !quiet && !query.has("all") && !query.has("scope");
  const phone = layout === "phone";
  const marketsEnabled = roster.markets.length > 0 && !query.has("scope") && (inCategory || query.has("all"));
  const market = query.get("market") ?? "";
  const place = noCategory
    ? "No category"
    : loading && !fromTile
      ? ""
      : (roster.categories.find((entry) => entry.slug === category)?.label ?? "");
  const owned = roster.rows.filter((row) => !owner || row.owner_label.toLowerCase() === owner);
  const placeRows = owned.filter(
    (row) =>
      (!query.has("scope") || row.owned_by_viewer) &&
      (!category || row.categories.some((entry) => entry.slug === category)) &&
      (!noCategory || row.categories.length === 0),
  );
  const matching = placeRows.filter((row) => (!quiet || row.quiet) && row.name.toLowerCase().includes(search));
  const count = `${matching.length} ${matching.length === 1 ? "vendor" : "vendors"}`;
  const status = loading ? "Checking…" : count;
  const byName = (a: Vendor, b: Vendor) => a.name.localeCompare(b.name);
  const byTerritory = (a: Vendor, b: Vendor) =>
    Number(a.territory === null) - Number(b.territory === null) ||
    (a.territory ?? "").toLowerCase().localeCompare((b.territory ?? "").toLowerCase()) ||
    byName(a, b);
  const ranked = matching.toSorted(
    sort === "territory"
      ? byTerritory
      : sort === "name"
        ? byName
        : (a, b) => relationshipRank(a) - relationshipRank(b) || byName(a, b),
  );
  const window = inCategory || marketsEnabled ? ranked : ranked.slice(0, page * PAGE_SIZE);
  const relation = query.get("relationship");
  const marketRows = window.filter((row) => inMarket(row, market));
  const rows = marketRows.filter((row) => !relation || relationships[relationshipRank(row)]?.[0] === relation);
  const showRows = !showTiles && !loading && !meetings;
  const categories = roster.categories.map(
    ({ label, slug }) => [label, owned.filter((row) => row.categories.some((entry) => entry.slug === slug))] as const,
  );
  const searchbox: SurfaceElement = {
    role: "searchbox",
    name: "Search",
    value: query.get("q") ?? "",
    placeholder: place ? `Find in ${place}` : "Find a vendor",
  };
  const back: SurfaceElement[] = inCategory ? [{ role: "link", name: "Vendors", text: "Vendors" }] : [];
  const heading = place
    ? [text(place), ...(!phone ? [text(`· ${status}`)] : [])]
    : phone || (loading && category)
      ? []
      : [text(status)];
  const activeTerritories = marketsEnabled && !meetings;
  const slottedSearch = roster.markets.length > 0 && !phone;
  const filters = showRows
    ? tableControls(marketRows, inCategory || marketsEnabled, relation, quiet)
    : [hidden("group", "Show only")];
  const columns = [
    button("Name", sort === "name"),
    button("Relationship", (sort ?? "relationship") === "relationship"),
    ...(!inCategory && !query.has("record") ? [text("Category")] : []),
    button("Territory", sort === "territory"),
    ...(!query.has("record") ? [text("Location")] : []),
    text("Last contacted"),
    text("Owner"),
  ];
  const headers = !phone ? [element("listitem", columns.map((column) => column.text).join("")), ...columns] : [];
  const noMatches = "No vendors match these filters";
  const list = loading
    ? Array.from({ length: 8 }, () => element("listitem"))
    : rows.length === 0
      ? [element("listitem", `${noMatches} Clear filters`), text(noMatches), button("Clear filters")]
      : [...headers, ...rows.flatMap((row) => rowSurface(row, { phone, inCategory, cardOpen: query.has("record") }))];
  const categoryTiles = showTiles
    ? [
        element("generic"),
        element("list"),
        ...tile("All vendors", owned, phone),
        ...[...categories, ["No category", owned.filter((row) => row.categories.length === 0)] as const]
          .filter(([, rows]) => rows.length > 0)
          .flatMap(([label, rows]) => tile(label, rows, phone)),
      ]
    : [hidden("generic")];

  return {
    address: address(url),
    requests: showTiles ? [] : listRequests(query, page, marketsEnabled),
    elements: [
      element("group", "Vendors views"),
      ...back,
      ...heading,
      ...(live ? [button("New vendor")] : []),
      ...(slottedSearch && !meetings ? [searchbox] : []),
      element("group", "Vendor views"),
      button("Categories", !meetings),
      button("People worth meeting", meetings),
      element("group", "Record scope"),
      ...["All", "Joe", "Dell"].map((label) => button(label, (owner ?? "all") === label.toLowerCase())),
      element("main"),
      ...(!meetings && !slottedSearch ? [searchbox] : []),
      ...(!meetings && (!activeTerritories || phone) ? [hidden("group")] : []),
      ...(!meetings && !activeTerritories ? filters : []),
      hidden("group", "Active filters"),
      ...(activeTerritories ? territoryTiles(roster.markets, placeRows, market) : [hidden("group", "Territories")]),
      ...(activeTerritories ? filters : []),
      hidden("status"),
      ...(meetings
        ? [
            hidden("region", place ? `Vendors / ${place}` : "Vendors"),
            element("region", "People worth meeting"),
            { role: "heading", name: "Research", text: "Research" },
            text("Search people and offices"),
            { role: "searchbox", name: "Search people and offices", value: "" },
            { role: "alert", text: "People could not be loaded. Try again." },
            button("Retry people"),
          ]
        : [
            element("region", place ? `Vendors / ${place}` : "Vendors"),
            ...categoryTiles,
            ...(showTiles ? [hidden("generic")] : [element("generic"), element("list"), ...list]),
          ]),
    ],
  };
}

export async function expectVendorScreen(page: Page, expected: ReturnType<typeof screenFor>) {
  const reads = pageReads.get(page);
  if (!reads) throw new Error("Vendors request capture must start before navigation");
  const { previous } = reads;
  const query = JSON.stringify(expected.address.query.filter(([key]) => !localParams.has(key)));
  // Opening a card or changing a local filter moves the address without fetching a list.
  const readsList =
    previous?.navigation === reads.navigation && previous.query === query
      ? (previous?.readsList ?? true)
      : previous?.query !== query;
  const wanted = { ...expected, requests: readsList ? expected.requests : [] };
  await expect
    .poll(async () => {
      const { href, elements } = await captureSurface(page);
      const requests = reads.urls.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { address: address(new URL(href)), requests, elements };
    })
    .toEqual(wanted);
  reads.previous = { navigation: reads.navigation, query, readsList };
}
