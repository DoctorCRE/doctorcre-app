import { foldEmailBody } from "./email-signature.ts";

const string = (value: unknown) => (typeof value === "string" ? value : null);
export const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

export type EmailThread = {
  subject: string | null;
  messages: { id: string; sender: string | null; occurredAt: string; body: string; folded: string | null }[];
};

export function emailThread(value: Record<string, unknown>): EmailThread {
  const messages = Array.isArray(value.thread)
    ? value.thread.flatMap((message: unknown) => {
        if (!isRecord(message)) return [];
        const { activity_id: id, happened_at: occurredAt, body, sender_name } = message;
        if (
          typeof id !== "string" ||
          !id ||
          typeof occurredAt !== "string" ||
          !Number.isFinite(Date.parse(occurredAt)) ||
          typeof body !== "string"
        )
          return [];
        const { text, folded } = foldEmailBody(body, string(sender_name));
        const earlier = string(message.folded);
        return [
          {
            id,
            occurredAt,
            body: text,
            sender: string(sender_name)?.trim().split(/\s+/, 1)[0] || null,
            folded: folded === null ? earlier : [folded, earlier].filter(Boolean).join("\n\n"),
          },
        ];
      })
    : [];
  return {
    messages,
    subject: messages.length && isRecord(value.source_activity) ? string(value.source_activity.subject) : null,
  };
}
