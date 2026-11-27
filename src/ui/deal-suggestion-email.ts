import { emailThread } from "./home/email-thread.ts";
import { object } from "./home/inbox.tsx";
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

/** Drops addresses from text partners read, keeping a quoted display name. */
export function redactEmailAddresses(text: string) {
  return text.replace(emailAddressInText, (_, name?: string) => name?.replace(bareEmailAddress, "") ?? "");
}

const paragraphs = (text: string | null) =>
  redactEmailAddresses(sourceExcerptText(text ?? ""))
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter(Boolean);

type SuggestionEmail = { sender: string; occurredAt: string; sent: string; paragraphs: string[] };

/** The suggestion's email as Home cleans it: sender and time, then its paragraphs. Null when unreadable. */
export function suggestionEmail(read: unknown, emailId: string): SuggestionEmail | null {
  const { messages } = object(read) ? emailThread(read) : { messages: [] };
  const message = messages.find(({ id }) => id === emailId) ?? messages.at(-1);
  const text = paragraphs(message?.body ?? null);
  if (!message || !text.length) return null;
  const { sender, occurredAt } = message;
  return {
    sender: sender ?? "an unknown sender",
    occurredAt,
    sent: sentAt.format(new Date(occurredAt)),
    paragraphs: text,
  };
}

type ConversationMessage = SuggestionEmail & { earlier: string[] };

/** A filed email's conversation as Home cleans it, oldest first, each message with its folded earlier text. */
export function emailConversation(read: unknown): ConversationMessage[] {
  const { messages } = object(read) ? emailThread(read) : { messages: [] };
  return messages.map(({ sender, occurredAt, body, folded }) => ({
    sender: sender ?? "an unknown sender",
    occurredAt,
    sent: sentAt.format(new Date(occurredAt)),
    paragraphs: paragraphs(body),
    earlier: paragraphs(folded),
  }));
}
