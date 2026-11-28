import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";

type Counts = { newFromEmail: number; followUpsLate: number };
const count = (value: unknown) => (Number.isSafeInteger(value) && Number(value) >= 0 ? Number(value) : null);

// The engine counts the Leads board's New from email and Follow-up late badges.
async function readLeadCounts(signal: AbortSignal): Promise<Counts> {
  const { sessionFetch } = await import(new URL("./private-session.js", import.meta.url).href);
  const response: Response = await sessionFetch("/api/engine/leads/counts", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw Error("Lead counts unavailable");
  const answer = await response.json();
  const newFromEmail = count(answer?.new_from_email);
  const followUpsLate = count(answer?.follow_ups_late);
  if (answer?.schema_version !== "lead-counts.v1" || newFromEmail === null || followUpsLate === null)
    throw Error("Lead counts unavailable");
  return { newFromEmail, followUpsLate };
}

function leadsSummary({ newFromEmail, followUpsLate }: Counts) {
  return [
    newFromEmail && `${newFromEmail} new from email`,
    followUpsLate && `${followUpsLate} ${followUpsLate === 1 ? "follow-up" : "follow-ups"} late`,
  ].filter((part): part is string => Boolean(part));
}

/** One line that opens Leads with the counts its New from email and Follow-up late badges show. */
export function LeadsLine() {
  const leads = useQuery({
    queryKey: ["home-leads"],
    queryFn: ({ signal }) => readLeadCounts(signal),
    // eslint-disable-next-line no-restricted-syntax -- The Leads counts read once a minute while visible and online.
    refetchInterval: () => (navigator.onLine && document.visibilityState === "visible" ? 60_000 : false),
  });
  const summary = leads.data ? leadsSummary(leads.data) : leads.isError ? ["Lead counts unavailable"] : [];
  if (!summary.length) return null;
  return (
    <section className="home-slice home-door-tile" aria-label="Leads">
      <a className="home-door" href="/leads">
        <strong>Leads</strong>
        {leads.data?.newFromEmail ? <span className="home-dot-info" aria-hidden="true" /> : null}
        <span className="home-door-detail">
          {summary.map((part, index) => (
            <Fragment key={part}>
              {index > 0 && " · "}
              <span>{part}</span>
            </Fragment>
          ))}
        </span>
      </a>
    </section>
  );
}
