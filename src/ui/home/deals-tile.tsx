import { useQuery } from "@tanstack/react-query";
import { dealsAtAGlance, reviewProgress, reviewWeek } from "./deal-tiles";
import { counted, Fold } from "./fold";
import { day, PlaceholderTile } from "./sections";

const sibling = (path: string) => import(new URL(path, import.meta.url).href);

async function readDeals(signal: AbortSignal) {
  const today = day(new Date());
  // The board's own modules supply its rules, so Home counts exactly as the board does.
  const [{ createClient }, { sessionFetch }, ...rules] = await Promise.all(
    ["./client.js", "./private-session.js", "./deal-items.js", "./deal-review-model.js", "./pipeline-model.js"].map(
      sibling,
    ),
  );
  const read = async (path: string): Promise<unknown> => {
    const response: Response = await sessionFetch(path, {
      signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
    });
    if (!response.ok) throw Error("Deals unavailable");
    return response.json();
  };
  const [board, review] = await Promise.all([
    createClient("live", { docContext: false }).then((client: { getBoard: (options: object) => Promise<unknown> }) =>
      client.getBoard({ workspace: "team", signal }),
    ),
    read(`/api/engine/weekly-reviews?week_of=${reviewWeek(today)}`),
  ]);
  const glance = dealsAtAGlance(board, today, Object.assign({}, ...rules));
  return { ...glance, review: reviewProgress(review) };
}

/** The open count, each phase, the deals needing attention, and this week's Monday review, as the Deals board shows them. */
export function DealsTile() {
  const { data, isPending } = useQuery({
    queryKey: ["home-deals"],
    queryFn: ({ signal }) => readDeals(signal),
    // eslint-disable-next-line no-restricted-syntax -- The deals read once a minute while visible and online.
    refetchInterval: () => (navigator.onLine && document.visibilityState === "visible" ? 60_000 : false),
  });
  if (isPending) return <PlaceholderTile />;
  if (!data)
    return (
      <p className="home-tile-status" role="status">
        Deals unavailable.
      </p>
    );
  if (!data.open) return null;
  return (
    <section className="home-slice home-deals" aria-label="Deals">
      <header>
        <h2>
          Deals{" "}
          <span>
            <a href="/deals">{data.open} open</a>
          </span>
        </h2>
        <a className="home-tile-door" href="/deals">
          Board
        </a>
      </header>
      <ul className="home-phases">
        {data.phases.map((phase) => (
          <li key={phase.slug}>
            <a href={`/deals?column=${phase.slug}`}>
              {phase.label} <span>{phase.count}</span>
            </a>
          </li>
        ))}
      </ul>
      {data.attention.length > 0 && (
        <Fold label="Needs attention" line={counted(data.attention.length, "needs attention", "need attention")}>
          <h3>Needs attention</h3>
          <ul>
            {data.attention.map((deal) => (
              <li key={deal.id}>
                <a href={`/deals?deal=${encodeURIComponent(deal.id)}`} data-flagged={deal.flagged || undefined}>
                  {deal.name} <span data-late={deal.late || undefined}>{deal.reason}</span>
                </a>
              </li>
            ))}
          </ul>
        </Fold>
      )}
      {data.missingNextStep > 0 && (
        <a className="home-deals-line" href="/deals?view=list&filter=no-next-step">
          {counted(data.missingNextStep, "has no next step", "have no next step")}
        </a>
      )}
      {data.review.total > 0 && (
        <a className="home-deals-line" href="/deals?view=review">
          Monday review{" "}
          <span>
            {data.review.reviewed} of {data.review.total}
          </span>
        </a>
      )}
    </section>
  );
}
