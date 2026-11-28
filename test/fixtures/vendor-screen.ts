import type { TestContext } from "node:test";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import { chromium } from "../browser-harness.mjs";
import { ownedServer } from "../fixture-probe.ts";
import { directoryFixture, PAGE_SIZE, type VendorRoster } from "./vendor-directory.synthetic.mjs";

const origin = "http://fixture.test";
const fixtureTime = Date.parse("2026-11-28T15:30:00Z");
const listPath = "/api/v1/business/vendors";
const localParams = new Set(["record", "relationship", "market"]);
const automationFields = new Set(["ref", "active", "cursor"]);

type Address = ReturnType<typeof address>;
type ListRequest = Address & { method: string };
type ScreenRead = { navigation: number; document: number; query: string; readsList: boolean };
const pageReads = new WeakMap<
  Page,
  { urls: ListRequest[]; navigation: number; document: number; previous?: ScreenRead }
>();

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
  await page.clock.setFixedTime(fixtureTime);
  const listReads: ListRequest[] = [];
  const reads = { urls: listReads, navigation: 0, document: 0 };
  pageReads.set(page, reads);
  page.on("domcontentloaded", () => reads.document++);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    reads.navigation++;
    listReads.length = 0;
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === listPath) listReads.push({ ...address(url), method: request.method() });
  });
  await page.route("**/api/v1/business/**", (route) =>
    route.fulfill({ json: directoryFixture(route.request().url(), { roster, now: fixtureTime }) }),
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

type AriaState = { name?: string; url?: string; pressed?: true; level?: number };
type AriaNode = string | (AriaState & { role: string; text?: string; children?: AriaNode[] });
function node(role: string, content?: string | AriaNode[], state: AriaState = {}): AriaNode {
  return {
    role,
    ...state,
    ...(content?.length && (typeof content === "string" ? { text: content } : { children: content })),
  };
}
const generic = (content: string | AriaNode[]) => node("generic", content);
const button = (name: string, pressed = false, children?: AriaNode[]) =>
  node("button", children, { name, ...(pressed && { pressed: true }) });
const searchbox = (name: string, value: string) => node("searchbox", value, { name });
const link = (name: string, url: string, children?: AriaNode[]) => node("link", children, { name, url });
const words = (...parts: (string | null)[]) => parts.filter(Boolean).join(" ");

function vendorHref(params: URLSearchParams, record?: string) {
  const keys = [
    "scope",
    "q",
    "owner",
    "territory",
    "category",
    "no_category",
    "stage",
    "disposition",
    "quiet",
    "sort",
    "all",
    "relationship",
    "market",
  ];
  const query = new URLSearchParams(
    keys.flatMap((key) => {
      const value = params.get(key);
      return value ? [[key, value]] : [];
    }),
  );
  if (record) query.set("record", record);
  return query.size ? `/vendors?${query}` : "/vendors";
}

function tally(rows: Vendor[]) {
  return relationships.map(([key, label], rank) => ({
    key,
    label,
    count: rows.filter((row) => relationshipRank(row) === rank).length,
  }));
}

function tile(label: string, rows: Vendor[], phone: boolean, href: string) {
  const quiet = rows.filter((row) => row.quiet).length;
  const mix = phone ? [] : tally(rows).filter(({ count }) => count > 0);
  const footer = quiet ? `${quiet} quiet` : "";
  const name = words(label, String(rows.length), ...mix.map(({ label, count }) => `${count} ${label}`), footer);
  return node("listitem", [
    link(name, href, [
      generic([generic(label), generic(String(rows.length))]),
      ...(!phone
        ? [
            node(
              "list",
              mix.map(({ label, count }) => node("listitem", [generic(String(count)), label])),
            ),
          ]
        : []),
      ...(footer ? [generic(footer)] : []),
    ]),
  ]);
}

function rowAria(row: Vendor, query: URLSearchParams, phone: boolean, inCategory: boolean) {
  const rank = relationshipRank(row);
  const related = relationships[rank]?.[1] ?? "";
  const target = row.is_target && rank !== 6 ? "Want to meet" : "";
  const contacted = row.relationship.last_contacted_at;
  const date = contacted
    ? new Date(contacted).toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "America/Chicago" })
    : "";
  const days = date && row.quiet && row.quiet_days !== null ? `· ${row.quiet_days} days` : "";
  const contact = date || (row.quiet ? "No contact yet" : "");
  const expanded = !phone && !query.has("record");
  const facts = [
    ["Relationship", related],
    ["Category", expanded && !inCategory ? row.recorded_category_label : ""],
    ["Territory", row.territory],
    ["Location", expanded ? `${row.city}, ${row.state}` : ""],
  ];
  const owner = phone ? "" : row.owner_label;
  const name = words(
    row.name,
    target,
    ...facts.map(([label, value]) => (value ? words(label ?? "", value) : "")),
    contact ? words("Last contacted", contact, days) : "",
    owner ? `Owner: ${owner}` : "",
  );
  const visibleFacts = facts.flatMap(([label, value]) =>
    label && value ? [generic([generic(label), generic(value)])] : [],
  );
  return node("listitem", [
    link(name, vendorHref(query, row.id), [
      target ? generic([generic(row.name), generic(target)]) : generic(row.name),
      ...(visibleFacts.length === 1 ? visibleFacts : [generic(visibleFacts)]),
      ...(contact
        ? [generic([generic("Last contacted"), date ? node("time", date) : contact, ...(days ? [days] : [])])]
        : []),
      ...(owner ? [generic([generic("Owner:"), owner])] : []),
    ]),
  ]);
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
  return node(
    "group",
    counts.map(({ id, label, count }) =>
      button(`${label} ${count}`, id === selected, [generic(label), generic(String(count))]),
    ),
    { name: "Territories" },
  );
}

function tableControls(rows: Vendor[], counted: boolean, relation: string | null, quiet: boolean) {
  const counts = counted ? tally(rows).filter(({ key, count }) => count > 0 || key === relation) : [];
  const control = (label: string, count: number, pressed: boolean) =>
    button(`${label} ${count}`, pressed, [label, generic(String(count))]);
  return node(
    "group",
    [
      ...counts.map(({ key, label, count }) => control(label, count, key === relation)),
      counted ? control("Quiet", rows.filter((row) => row.quiet).length, quiet) : button("Quiet", quiet),
    ],
    { name: "Show only" },
  );
}

function listRequests(query: URLSearchParams, pages: number, markets: boolean) {
  const params = new URLSearchParams(query);
  for (const key of localParams) params.delete(key);
  params.delete("all");
  if (markets) params.set("markets", "true");
  return Array.from({ length: pages }, (_, i) => {
    if (i) params.set("page", String(i + 1));
    return { ...address(new URL(vendorListRequest(params.toString()), origin)), method: "GET" };
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
    afterList = false,
  }: {
    view?: string;
    layout?: "desktop" | "phone";
    page?: number;
    loading?: boolean;
    fromTile?: boolean;
    meetings?: boolean;
    live?: boolean;
    afterList?: boolean;
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
  const searchField = generic([generic("Search"), searchbox("Search", query.get("q") ?? "")]);
  const title = place ? `Vendors / ${place}` : "Vendors";
  const summary =
    place && phone
      ? node("paragraph", [place, generic(`· ${status}`)])
      : node("paragraph", place ? `${place} · ${status}` : loading && category ? "" : status);
  const ownerParams = new URLSearchParams(owner ? { owner } : {});
  const heading = generic([
    node("heading", undefined, { name: title, level: 1 }),
    ...(inCategory ? [link("‹ Vendors /", vendorHref(ownerParams))] : []),
    inCategory ? "/" : "‹/ /",
    summary,
    ...(live ? [button("New vendor")] : []),
  ]);

  const slottedSearch = roster.markets.length > 0 && !phone;
  const territories = marketsEnabled ? [territoryTiles(roster.markets, placeRows, market)] : [];
  const filters = showRows ? [tableControls(marketRows, inCategory || marketsEnabled, relation, quiet)] : [];
  const sortable = (label: string) => button(label, (sort ?? "relationship") === label.toLowerCase());
  const wide = !query.has("record");
  const headers = phone
    ? []
    : [
        node("listitem", [
          sortable("Name"),
          generic([
            sortable("Relationship"),
            ...(!inCategory && wide ? [generic("Category")] : []),
            sortable("Territory"),
            ...(wide ? [generic("Location")] : []),
          ]),
          generic("Last contacted"),
          generic("Owner"),
        ]),
      ];
  const list = loading
    ? Array.from({ length: 8 }, () => node("listitem"))
    : rows.length === 0
      ? [node("listitem", [node("paragraph", "No vendors match these filters"), button("Clear filters")])]
      : [...headers, ...rows.map((row) => rowAria(row, query, phone, inCategory))];
  const tileHref = (key: string, value: string) => vendorHref(new URLSearchParams([...ownerParams, [key, value]]));
  const categoryTiles = [
    tile("All vendors", owned, phone, tileHref("all", "true")),
    ...roster.categories.flatMap(({ label, slug }) => {
      const vendors = owned.filter((row) => row.categories.some((entry) => entry.slug === slug));
      return vendors.length ? [tile(label, vendors, phone, tileHref("category", slug))] : [];
    }),
  ];
  const noCategoryRows = owned.filter((row) => row.categories.length === 0);
  if (noCategoryRows.length)
    categoryTiles.push(tile("No category", noCategoryRows, phone, tileHref("no_category", "true")));
  const stamp = node("generic", loading ? "Checking…" : showTiles && !afterList ? "Updating…" : "Updated 9:30 AM", {
    name: "Status",
  });
  const meetingsView = node(
    "region",
    [
      node("heading", undefined, { name: "Research", level: 2 }),
      generic(["Search people and offices", searchbox("Search people and offices", "")]),
      generic([node("alert", "People could not be loaded. Try again."), button("Retry people")]),
    ],
    { name: "People worth meeting" },
  );
  return {
    address: address(url),
    requests: showTiles ? [] : listRequests(query, page, marketsEnabled),
    quietRows: showRows ? rows.filter((row) => row.quiet).map((row) => row.id) : [],
    tabs: [
      node(
        "group",
        [
          heading,
          ...(slottedSearch && !meetings ? [searchField] : []),
          node("group", [button("Categories", !meetings), button("People worth meeting", meetings)], {
            name: "Vendor views",
          }),
          node(
            "group",
            ["All", "Joe", "Dell"].map((label) => button(label, (owner ?? "all") === label.toLowerCase())),
            { name: "Record scope" },
          ),
        ],
        { name: "Vendors views" },
      ),
    ],
    main: [
      node(
        "main",
        meetings
          ? [meetingsView]
          : [
              ...(!marketsEnabled || phone
                ? [generic([...(!slottedSearch ? [searchField] : []), ...(!marketsEnabled ? filters : []), stamp])]
                : []),
              ...territories,
              ...(marketsEnabled ? filters : []),
              node("region", [node("list", showTiles ? categoryTiles : list)], { name: title }),
            ],
      ),
    ],
  };
}

function snapshotContent(value: unknown): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((entry: unknown) =>
    entry !== null && typeof entry === "object"
      ? Object.fromEntries(
          Object.entries(entry)
            .filter(([key]) => !automationFields.has(key))
            .map(([key, content]) => [key, key === "children" ? snapshotContent(content) : content]),
        )
      : entry,
  );
}

export async function expectVendorScreen(page: Page, expected: ReturnType<typeof screenFor>) {
  const reads = pageReads.get(page);
  if (!reads) throw new Error("Vendors request capture must start before navigation");
  const { previous } = reads;
  const query = JSON.stringify(expected.address.query.filter(([key]) => !localParams.has(key)));
  // A new document reads its list even when the query is the same. Local filters and cards only move the address.
  const readsList =
    previous?.document !== reads.document ||
    (previous.navigation === reads.navigation && previous.query === query
      ? previous.readsList
      : previous.query !== query);
  const wanted = { ...expected, requests: readsList ? expected.requests : [] };
  await expect
    .poll(async () => {
      const [tabs, main] = await Promise.all(
        ["#appTabsSlot", "main.business-shell"].map(async (selector): Promise<unknown> => {
          const snapshot: unknown = await page.locator(selector).ariaSnapshotJSON({ mode: "ai" });
          return snapshotContent(snapshot);
        }),
      );
      const quietRows = await page
        .locator("main.business-shell .record-row:visible:has(.contact-note.quiet)")
        .evaluateAll((rows) => rows.map((row) => row.getAttribute("data-record-id")));
      const requests = reads.urls.toSorted((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
      return { address: address(new URL(page.url())), requests, quietRows, tabs, main };
    })
    .toEqual(wanted);
  reads.previous = { navigation: reads.navigation, document: reads.document, query, readsList };
}
