import type { TestContext } from "node:test";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import { chromium } from "../browser-harness.mjs";
import { ownedServer } from "../fixture-probe.ts";
import { directoryFixture, PAGE_SIZE, type VendorRoster } from "./vendor-directory.synthetic.mjs";

const origin = "http://fixture.test";
const listPath = "/api/v1/business/vendors";
const localParams = new Set(["record", "relationship", "market"]);

type Address = ReturnType<typeof address>;
type ScreenRead = { navigation: number; query: string; readsList: boolean };
const pageReads = new WeakMap<Page, { urls: Map<string, Address>; navigation: number; previous?: ScreenRead }>();

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
  const listReads = new Map<string, Address>();
  const reads = { urls: listReads, navigation: 0 };
  pageReads.set(page, reads);
  page.on("framenavigated", (frame) => {
    if (frame !== page.mainFrame()) return;
    reads.navigation++;
    listReads.clear();
  });
  page.on("request", (request) => {
    const url = new URL(request.url());
    if (url.pathname === listPath) {
      const target = address(url);
      listReads.set(JSON.stringify(target), target);
    }
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

function tile(label: string, rows: Vendor[], phone: boolean) {
  const quiet = rows.filter((row) => row.quiet).length;
  return {
    label,
    count: String(rows.length),
    quiet: quiet ? `${quiet} quiet` : "",
    mix: phone
      ? []
      : relationships.flatMap(([, word], rank) => {
          const count = rows.filter((row) => relationshipRank(row) === rank).length;
          return count ? [`${count} ${word}`] : [];
        }),
  };
}

function screenRow(
  row: Vendor,
  { phone, inCategory, cardOpen }: { phone: boolean; inCategory: boolean; cardOpen: boolean },
) {
  const rank = relationshipRank(row);
  const contacted = row.relationship.last_contacted_at;
  const date = contacted
    ? new Date(contacted).toLocaleDateString("en-US", {
        dateStyle: "medium",
        timeZone: "America/Chicago",
      })
    : "";
  const days = row.quiet && row.quiet_days !== null ? ` · ${row.quiet_days} days` : "";
  return {
    name: row.name,
    relationship: relationships[rank]?.[1] ?? "",
    territory: row.territory ?? "",
    contact: date ? date + days : row.quiet ? "No contact yet" : "",
    target: row.is_target && rank !== 6 ? "Want to meet" : "",
    owner: phone ? "" : row.owner_label,
    category: phone || inCategory || cardOpen ? "" : (row.recorded_category_label ?? ""),
    location: phone || cardOpen ? "" : `${row.city}, ${row.state}`,
  };
}

function inMarket(row: Vendor, market: string) {
  if (!market) return true;
  if (market === "elsewhere") return row.territory !== null && row.markets.length === 0;
  if (market === "no_territory") return row.territory === null;
  return row.markets.some(({ id }) => id === market);
}

function territoryTiles(markets: VendorRoster["markets"], rows: Vendor[], selected: string) {
  const filter = (id: string, label: string, count: number) => ({
    label,
    count: String(count),
    pressed: id === selected,
  });
  return [
    filter("", "All territories", rows.length),
    ...markets
      .map(({ id, name }) => filter(id, name, rows.filter((row) => inMarket(row, id)).length))
      .filter(({ count }) => count !== "0"),
    filter("elsewhere", "Elsewhere", rows.filter((row) => inMarket(row, "elsewhere")).length),
    filter("no_territory", "No territory", rows.filter((row) => inMarket(row, "no_territory")).length),
  ];
}

function filterControl(label: string, pressed: boolean, count = "") {
  return { label, count, pressed };
}

function tableControls(rows: Vendor[], counted: boolean, relation: string | null, quiet: boolean) {
  const counts = relationships.flatMap(([key, label], rank) => {
    const count = rows.filter((row) => relationshipRank(row) === rank).length;
    return count || key === relation ? [filterControl(label, key === relation, String(count))] : [];
  });
  return [
    ...(counted ? counts : []),
    filterControl("Quiet", quiet, counted ? String(rows.filter((row) => row.quiet).length) : ""),
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
  }: {
    view?: string;
    layout?: "desktop" | "phone";
    page?: number;
    loading?: boolean;
    fromTile?: boolean;
    meetings?: boolean;
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
  return {
    address: address(url),
    heading: phone ? place : place ? `${place} · ${status}` : loading && category ? "" : status,
    placeholder: meetings ? "" : place ? `Find in ${place}` : "Find a vendor",
    loading,
    groups: {
      territories: marketsEnabled && !meetings,
      filters: showRows,
      tiles: showTiles && !meetings,
      list: !showTiles && !meetings,
    },
    filters: showRows ? tableControls(marketRows, inCategory || marketsEnabled, relation, quiet) : [],
    owners: ["All", "Joe", "Dell"].map((label) => filterControl(label, (owner ?? "all") === label.toLowerCase())),
    sortControls:
      !phone && showRows && rows.length > 0
        ? ["Name", "Relationship", "Territory"].map((label) =>
            filterControl(label, (sort ?? "relationship") === label.toLowerCase()),
          )
        : [],
    requests: showTiles ? [] : listRequests(query, page, marketsEnabled),
    categoryColumn: !phone && showRows && !inCategory && !query.has("record") && rows.length > 0,
    territories: marketsEnabled && !meetings ? territoryTiles(roster.markets, placeRows, market) : [],
    tiles:
      showTiles && !loading && !meetings
        ? [
            tile("All vendors", owned, phone),
            ...[...categories, ["No category", owned.filter((row) => row.categories.length === 0)] as const]
              .filter(([, rows]) => rows.length > 0)
              .map(([label, rows]) => tile(label, rows, phone)),
          ]
        : [],
    rows: showRows ? rows.map((row) => screenRow(row, { phone, inCategory, cardOpen: query.has("record") })) : [],
    empty: showRows && rows.length === 0 ? "No vendors match these filters" : "",
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
      const screen = await page.evaluate(() => {
        function visible(element: Element | null): element is HTMLElement {
          if (!(element instanceof HTMLElement) || !element.checkVisibility({ visibilityProperty: true })) return false;
          const { clip, clipPath } = getComputedStyle(element);
          return clip !== "rect(0px, 0px, 0px, 0px)" && clipPath !== "inset(50%)";
        }
        const find = (selector: string, parent: ParentNode = document) =>
          [...parent.querySelectorAll(selector)].filter(visible);
        function visibleText(element: HTMLElement, omit?: Element | null): string {
          return [...element.childNodes]
            .map((node) =>
              node.nodeType === Node.TEXT_NODE
                ? node.textContent
                : node instanceof Element && node !== omit && visible(node)
                  ? visibleText(node, omit)
                  : "",
            )
            .join("");
        }
        function text(parent: ParentNode, selector: string) {
          const element = find(selector, parent)[0];
          return element ? visibleText(element).trim().replace(/\s+/g, " ") : "";
        }
        function control(button: HTMLElement) {
          return {
            label: visibleText(button, button.querySelector(".tile-n")).trim().replace(/\s+/g, " "),
            count: text(button, ".tile-n"),
            pressed: button.getAttribute("aria-pressed") === "true",
          };
        }
        const fact = (row: HTMLElement, label: string) => text(row, `[data-fact="${label}"] .fact-value`);
        const input = document.querySelector<HTMLInputElement>("#searchInput");
        return {
          href: location.href,
          heading: text(document, "#resultSummary"),
          placeholder: input && visible(input) ? input.placeholder : "",
          loading: find(".record-skeleton, #directoryTiles .skeleton-line").length > 0,
          groups: {
            territories: visible(document.querySelector("#vendorTerritories")),
            filters: visible(document.querySelector("#tableFilters")),
            tiles: visible(document.querySelector("#directoryTiles")),
            list: visible(document.querySelector("#listRegion")),
          },
          filters: find("#tableFilters button").map(control),
          owners: find("#scopeSwitch button").map(control),
          sortControls: find(".list-head [data-column-sort]").map(control),
          categoryColumn: find('.list-head [data-fact="Category"]').length > 0,
          territories: find("#vendorTerritories button").map((button) => ({
            label: text(button, "span:first-child"),
            count: text(button, ".tile-n"),
            pressed: button.getAttribute("aria-pressed") === "true",
          })),
          tiles: find("a.directory-tile").map((tile) => ({
            label: text(tile, ".tile-name"),
            count: text(tile, ".tile-count"),
            quiet: text(tile, ".tile-quiet"),
            mix: find(".tile-mix li", tile).map((item) => visibleText(item).trim().replace(/\s+/g, " ")),
          })),
          rows: find(".record-row").map((row) => ({
            name: text(row, ".row-name"),
            relationship: fact(row, "Relationship"),
            territory: fact(row, "Territory"),
            contact: text(row, ".contact-note"),
            target: text(row, ".want-tag"),
            owner: text(row, ".row-owner"),
            category: fact(row, "Category"),
            location: fact(row, "Location"),
          })),
          empty: text(document, ".record-empty .empty-title"),
        };
      });
      const { href, ...visible } = screen;
      const requests = [...reads.urls].sort(([a], [b]) => a.localeCompare(b)).map(([, url]) => url);
      return { address: address(new URL(href)), ...visible, requests };
    })
    .toEqual(wanted);
  reads.previous = { navigation: reads.navigation, query, readsList };
}
