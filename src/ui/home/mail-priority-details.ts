import { createPageBudget } from "../../../js/read-budget.mjs";
import type { MailPage } from "./mail-priorities-client";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);
const object = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown) => (typeof value === "string" ? value.trim() : "");

function emailDetails(row: Record<string, unknown>) {
  const source = object(row.source) ? row.source : {};
  const sender = text(source.sender);
  const subject = text(source.subject);
  const nextStep = object(row.proposed_next_step) ? text(row.proposed_next_step.text) : "";
  const preview = object(row.preview) ? row.preview : {};
  return {
    sender: sender.split("<", 1)[0]?.replace(/^["'\s]+|["'\s]+$/g, "") || sender.match(/<([^<>]+)>/)?.[1] || sender,
    subject,
    context: text(row.deal_name) || text(row.subject_name),
    suggestion: nextStep || text(row.proposed_matter) || (row.kind === "next_step" ? text(preview.text) : ""),
  };
}

export type MailDetails = ReadonlyMap<string, ReturnType<typeof emailDetails>>;

export async function readMailDetails(items: MailPage["items"], signal: AbortSignal): Promise<MailDetails> {
  const found = new Map<string, ReturnType<typeof emailDetails>>();
  if (!items.length) return found;
  const { readHomeEmailProposalPage } = await sibling("./home-boot.js");
  const remaining = new Set(items.map((row) => row.proposal_id));
  const takePage = createPageBudget();
  let cursor: string | null = null;
  // eslint-disable-next-line no-restricted-syntax -- Each page consumes the shared read budget and stops once all ranked IDs have been found.
  do {
    signal.throwIfAborted();
    takePage();
    const page: { proposals: unknown[]; next_cursor: string | null } = await readHomeEmailProposalPage({
      cursor,
      signal,
    });
    for (const row of page.proposals) {
      if (object(row) && typeof row.id === "string" && remaining.delete(row.id)) {
        found.set(row.id, emailDetails(row));
      }
    }
    cursor = page.next_cursor;
  } while (cursor && remaining.size);
  return found;
}
