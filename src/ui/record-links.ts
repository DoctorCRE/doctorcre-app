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
  const urls = new Map((Array.isArray(links) ? links : []).filter(isRecordLink).map((link) => [link.text, link.url]));
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
