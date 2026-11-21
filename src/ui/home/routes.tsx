import type { InboxItem } from "./inbox";
export const recordPages = new Map([
  ["/deals", "deal"],
  ["/calls", "call"],
  ["/doc-chats", "document chat"],
  ["/leases", "lease"],
  ["/clients", "client"],
  ["/relationships", "contact"],
]);
const recordId = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
export const recordRoutes = {
  card: (id: string) => `/inbox/card/${encodeURIComponent(id)}`,
  checklist(item: InboxItem): string | null {
    const ref = item.checklistItemRef;
    if (!item.deal_id || !ref) return null;
    const params = new URLSearchParams({ deal: item.deal_id });
    const dealItem = ref.startsWith("deal-item:") ? ref.slice("deal-item:".length) : null;
    if (dealItem && recordId.test(dealItem)) params.set("item", dealItem);
    else params.set("checklist", ref);
    return `/deals?${params}`;
  },
  source(item: Pick<InboxItem, "open_url">): string | null {
    const url = item.open_url;
    if (
      !url?.startsWith("/") ||
      url.startsWith("//") ||
      /[\\\s]/.test(url) ||
      Array.from(url).some((char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127)
    )
      return null;
    const parsed = new URL(url, "https://doctorcre.invalid");
    if (parsed.pathname === "/leases") {
      const leases = parsed.searchParams.getAll("lease");
      return leases.length === 1 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(leases[0] ?? "") &&
        [...parsed.searchParams.keys()].every((key) => key === "lease") &&
        !parsed.hash
        ? url
        : null;
    }
    if (parsed.pathname === "/clients") {
      const records = parsed.searchParams.getAll("record");
      return records.length === 1 && recordId.test(records[0] ?? "") ? url : null;
    }
    if (parsed.pathname === "/relationships") {
      const [node, ...others] = parsed.searchParams.getAll("node");
      return node?.startsWith("party:") && recordId.test(node.slice("party:".length)) && !others.length ? url : null;
    }
    const supported = recordPages.has(parsed.pathname);
    return parsed.origin === "https://doctorcre.invalid" && supported ? url : null;
  },
};
