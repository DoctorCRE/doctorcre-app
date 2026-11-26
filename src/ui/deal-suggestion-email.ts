import { emailThread, isRecord } from "./home/email-thread.ts";
import { sourceExcerptText } from "./home/source-excerpt.ts";

const bareEmailAddress =
  /(?:"(?:\\[^\r\n]|[^"\\\r\n])+"|[\p{L}\p{N}.!#$%&'*+/=?^_`{|}~-]+)@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+/gu;
const emailAddressInText = new RegExp(
  String.raw`(?:"([^"\r\n]+)"[ \t]*)?<${bareEmailAddress.source}>|${bareEmailAddress.source}`,
  "gu",
);
const sentAt = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Chicago",
  weekday: "short",
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});
const escapes: Record<string, string> = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (text: string) => text.replace(/[&<>"']/g, (char) => escapes[char] ?? char);

/** Drops addresses from text partners read, keeping a quoted display name. */
export function redactEmailAddresses(text: string) {
  return text.replace(emailAddressInText, (_, name?: string) => name?.replace(bareEmailAddress, "") ?? "");
}

/** The suggestion's email as Home cleans it: sender and time, then its paragraphs. Empty when unreadable. */
export function suggestionEmailHtml(read: unknown, emailId: string): string {
  const { messages } = isRecord(read) ? emailThread(read) : { messages: [] };
  const message = messages.find(({ id }) => id === emailId) ?? messages.at(-1);
  const paragraphs = redactEmailAddresses(sourceExcerptText(message?.body ?? ""))
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);
  if (!message || !paragraphs.length) return "";
  const from = `From ${esc(message.sender ?? "an unknown sender")} · <time datetime="${esc(message.occurredAt)}">${sentAt.format(new Date(message.occurredAt))}</time>`;
  return `<p class="deal-suggestion-from">${from}</p>${paragraphs.map((paragraph) => `<p>${esc(paragraph)}</p>`).join("")}`;
}
