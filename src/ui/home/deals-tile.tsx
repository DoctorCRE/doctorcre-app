import { useQuery } from "@tanstack/react-query";
import { dealsAtAGlance, reviewCounts, reviewWeek } from "./deal-tiles";
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
  return { ...dealsAtAGlance(board, today, Object.assign({}, ...rules)), review: reviewCounts(review) };
}

/** The heading counts this week's Monday review items, so its parts add up to the review total; the phases and attention list are the Deals board's. */
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
  const { review } = data;
  if (!review.total) return null;
  return (
    <section className="home-slice home-deals" aria-label="Deals">
      <header>
        <h2>
          Deals{" "}
          <span>
            <a href="/deals">{review.open} open</a>
            {!!review.parked && <> · {review.parked} parked</>}
            {!!review.national && <> · {review.national} in national accounts</>}
            {!!review.prospects && <> · {counted(review.prospects, "prospect", "prospects")}</>}
            {!!review.closed && <> · {review.closed} closed or lost this week</>}
            {!!review.dropped && <> · {review.dropped} dropped this week</>}
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
      <a className="home-deals-line" href="/deals?view=review">
        Monday review{" "}
        <span>
          {review.reviewed} of {review.total}
        </span>
      </a>
    </section>
  );
}
