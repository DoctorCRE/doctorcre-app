import type { TestContext } from "node:test";
import { expect } from "@playwright/test";
import type { Page } from "playwright";
import { chromium } from "../browser-harness.mjs";
import { ownedServer } from "../fixture-probe.ts";
import { directoryFixture, PAGE_SIZE, type VendorRoster } from "./vendor-directory.synthetic.mjs";

const origin = "http://fixture.test";
const listPath = "/api/v1/business/vendors";

function address(url: URL) {
  return { path: url.pathname, query: [...url.searchParams].sort() };
}

export function matchesVendorRequest(url: URL, path: string) {
  const wanted = address(new URL(path, origin));
  const actual = address(url);
  return actual.path === wanted.path && JSON.stringify(actual.query) === JSON.stringify(wanted.query);
}

export function vendorListRequest(query: string) {
  return `${listPath}?contract=vendor-directory.v1&${query}`;
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
  { width = 1440, height = 900, view = "/vendors", live = false, light = false, holdQuery = "" } = {},
) {
  const server = await ownedServer();
  t.after(() => server.stop());
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width, height }, colorScheme: light ? "light" : "dark" });
  if (light)
    await page.addInitScript(() =>
      localStorage.setItem("doctorcre.visual-preferences", JSON.stringify({ theme: "light" })),
    );
  const asked: URL[] = [];
  await page.route("**/api/v1/business/**", (route) => {
    const url = route.request().url();
    asked.push(new URL(url));
    return route.fulfill({ json: directoryFixture(url, { roster }) });
  });
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
    await page.route(
      (url) => url.pathname === "/vendors",
      async (route) => {
        const response = await route.fetch();
        return route.fulfill({
          response,
          body: (await response.text()).replace("<html ", "<html data-clients-vendors-from-engine "),
        });
      },
    );
  }
  const heldList = holdQuery ? await holdVendorList(page, holdQuery) : undefined;
  const url = new URL(view, server.url);
  if (live) url.searchParams.set("mode", "live");
  await page.goto(url.href);
  return { page, asked, heldList };
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
    territory: row.territory,
    contact: date ? date + days : row.quiet ? "No contact yet" : "",
    target: row.is_target && rank !== 6 ? "Want to meet" : "",
    owner: phone ? "" : row.owner_label,
    category: phone || inCategory || cardOpen ? "" : (row.recorded_category_label ?? ""),
    location: phone || cardOpen ? "" : `${row.city}, ${row.state}`,
  };
}

export function screenFor(
  roster: VendorRoster,
  {
    view = "/vendors",
    layout = "desktop",
    page = 1,
    loading = false,
    fromTile = false,
  }: { view?: string; layout?: "desktop" | "phone"; page?: number; loading?: boolean; fromTile?: boolean } = {},
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
  const place = noCategory
    ? "No category"
    : loading && !fromTile
      ? ""
      : (roster.categories.find((entry) => entry.slug === category)?.label ?? "");
  const owned = roster.rows.filter((row) => !owner || row.owner_label.toLowerCase() === owner);
  const matching = owned.filter(
    (row) =>
      (!query.has("scope") || row.owned_by_viewer) &&
      (!category || row.categories.some((entry) => entry.slug === category)) &&
      (!noCategory || row.categories.length === 0) &&
      (!quiet || row.quiet) &&
      row.name.toLowerCase().includes(search),
  );
  const count = `${matching.length} ${matching.length === 1 ? "vendor" : "vendors"}`;
  const status = loading ? "Checking…" : count;
  const ranked = matching.toSorted(
    (a, b) => (sort === "name" ? 0 : relationshipRank(a) - relationshipRank(b)) || a.name.localeCompare(b.name),
  );
  const window = inCategory ? ranked : ranked.slice(0, page * PAGE_SIZE);
  const relation = query.get("relationship");
  const rows = window.filter((row) => !relation || relationships[relationshipRank(row)]?.[0] === relation);
  const categories = roster.categories.map(
    ({ label, slug }) => [label, owned.filter((row) => row.categories.some((entry) => entry.slug === slug))] as const,
  );
  return {
    address: address(url),
    heading: phone ? place : place ? `${place} · ${status}` : loading && category ? "" : status,
    placeholder: place ? `Find in ${place}` : "Find a vendor",
    loading,
    categoryColumn: !phone && !loading && !showTiles && !inCategory && !query.has("record") && rows.length > 0,
    tiles:
      showTiles && !loading
        ? [
            tile("All vendors", owned, phone),
            ...[...categories, ["No category", owned.filter((row) => row.categories.length === 0)] as const]
              .filter(([, rows]) => rows.length > 0)
              .map(([label, rows]) => tile(label, rows, phone)),
          ]
        : [],
    rows:
      showTiles || loading
        ? []
        : rows.map((row) => screenRow(row, { phone, inCategory, cardOpen: query.has("record") })),
    empty: !loading && !showTiles && rows.length === 0 ? "No vendors match these filters" : "",
  };
}

export async function expectVendorScreen(page: Page, expected: ReturnType<typeof screenFor>) {
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
        function visibleText(element: HTMLElement): string {
          return [...element.childNodes]
            .map((node) =>
              node.nodeType === Node.TEXT_NODE
                ? node.textContent
                : node instanceof Element && visible(node)
                  ? visibleText(node)
                  : "",
            )
            .join("");
        }
        function text(parent: ParentNode, selector: string) {
          const element = find(selector, parent)[0];
          return element ? visibleText(element).trim().replace(/\s+/g, " ") : "";
        }
        const fact = (row: HTMLElement, label: string) => text(row, `[data-fact="${label}"] .fact-value`);
        const input = document.querySelector<HTMLInputElement>("#searchInput");
        return {
          href: location.href,
          heading: text(document, "#resultSummary"),
          placeholder: input && visible(input) ? input.placeholder : "",
          loading: find(".record-skeleton, #directoryTiles .skeleton-line").length > 0,
          categoryColumn: find('.list-head [data-fact="Category"]').length > 0,
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
      return { address: address(new URL(href)), ...visible };
    })
    .toEqual(expected);
}
