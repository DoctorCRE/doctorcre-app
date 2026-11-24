const RECORD_URL = /^\/relationships\?/;
const NAME_EDGE = String.raw`[\p{L}\p{N}]`;

const escapeText = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[char] ?? char,
  );

function isRecordLink(link: unknown): link is { text: string; url: string } {
  if (typeof link !== "object" || link === null || !("text" in link) || !("url" in link)) return false;
  return (
    typeof link.text === "string" &&
    link.text.trim() !== "" &&
    typeof link.url === "string" &&
    RECORD_URL.test(link.url)
  );
}

/** Escaped note text in which each name from a read's `record_links` opens its record. */
export function linkRecordNames(text: unknown, links: unknown): string {
  const urls = new Map<string, string>();
  const ambiguous = new Set<string>();
  for (const { text: name, url } of (Array.isArray(links) ? links : []).filter(isRecordLink)) {
    if (urls.has(name) && urls.get(name) !== url) ambiguous.add(name);
    urls.set(name, url);
  }
  // A name shared by two records cannot tell which one the note means.
  for (const name of ambiguous) urls.delete(name);
  if (!urls.size) return escapeText(text);
  const names = [...urls.keys()]
    .sort((a, b) => b.length - a.length)
    .map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return String(text ?? "")
    .split(new RegExp(`(?<!${NAME_EDGE})(${names.join("|")})(?!${NAME_EDGE})`, "u"))
    .map((part, index) =>
      index % 2 ? `<a href="${escapeText(urls.get(part))}">${escapeText(part)}</a>` : escapeText(part),
    )
    .join("");
}
