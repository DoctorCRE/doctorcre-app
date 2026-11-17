import type { InboxItem } from "./inbox";
export const recordPages = new Map([
  ["/deals", "deal"],
  ["/calls", "call"],
  ["/updates", "Updates"],
  ["/doc-chats", "document chat"],
  ["/leases", "lease"],
  ["/clients", "client"],
]);
export const recordRoutes = {
  card: (id: string) => `/inbox/card/${encodeURIComponent(id)}`,
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
      return records.length === 1 &&
        /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(records[0] ?? "")
        ? url
        : null;
    }
    if (parsed.pathname === "/notifications") return `/updates${parsed.search}${parsed.hash}`;
    const supported = recordPages.has(parsed.pathname);
    return parsed.origin === "https://doctorcre.invalid" && supported ? url : null;
  },
};
