import { object } from "./inbox.tsx";

const string = (value: unknown) => (typeof value === "string" ? value : null);

export type EmailThread = {
  subject: string | null;
  messages: { id: string; sender: string | null; occurredAt: string; body: string; folded: string | null }[];
};

/** The engine's thread as it answers it: each message's text, and its earlier text for Show earlier text. */
export function emailThread(value: Record<string, unknown>): EmailThread {
  const messages = Array.isArray(value.thread)
    ? value.thread.flatMap((message: unknown) => {
        if (!object(message)) return [];
        const { activity_id: id, happened_at: occurredAt, body, sender_name } = message;
        if (
          typeof id !== "string" ||
          !id ||
          typeof occurredAt !== "string" ||
          !Number.isFinite(Date.parse(occurredAt)) ||
          typeof body !== "string"
        )
          return [];
        return [
          {
            id,
            occurredAt,
            body,
            sender: string(sender_name)?.trim().split(/\s+/, 1)[0] || null,
            folded: string(message.folded),
          },
        ];
      })
    : [];
  return {
    messages,
    subject: messages.length && object(value.source_activity) ? string(value.source_activity.subject) : null,
  };
}
