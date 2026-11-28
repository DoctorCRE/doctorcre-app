import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import type { leadBadgeCounts } from "../../../js/leads-model.js";

type Counts = ReturnType<typeof leadBadgeCounts>;
const sibling = (path: string) => import(new URL(path, import.meta.url).href);

async function readLeadCounts(): Promise<Counts> {
  const [{ createLeadBoardClient }, model] = await Promise.all([
    sibling("./leads-client.js"),
    sibling("./leads-model.js"),
  ]);
  const client = createLeadBoardClient();
  const [workspace, quiet] = await Promise.all([client.getWorkspace(), client.getQuietFollowUps()]);
  return model.leadBadgeCounts(workspace.leads, quiet.proposals);
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
    queryFn: readLeadCounts,
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
