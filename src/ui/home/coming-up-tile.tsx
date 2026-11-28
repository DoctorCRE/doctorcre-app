import { useQuery } from "@tanstack/react-query";
import { comingUp, parseCriticalDates } from "./deal-tiles";
import { counted, Fold } from "./fold";
import { day, PlaceholderTile } from "./sections";

const weekday = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "short", month: "short", day: "numeric" });

async function readDates(signal: AbortSignal) {
  const { sessionFetch } = await import(new URL("./private-session.js", import.meta.url).href);
  const response: Response = await sessionFetch("/api/engine/calendar/critical-dates", {
    signal: AbortSignal.any([signal, AbortSignal.timeout(10_000)]),
  });
  if (!response.ok) throw Error("Coming up unavailable");
  return parseCriticalDates(await response.json());
}

/** Open critical dates on open deals in the next 14 days; each row opens Calendar on its day. */
export function ComingUpTile() {
  const { data, isPending } = useQuery({
    queryKey: ["home-coming-up"],
    queryFn: ({ signal }) => readDates(signal),
    // eslint-disable-next-line no-restricted-syntax -- The critical dates read once a minute while visible and online.
    refetchInterval: () => (navigator.onLine && document.visibilityState === "visible" ? 60_000 : false),
  });
  if (isPending) return <PlaceholderTile />;
  if (!data)
    return (
      <p className="home-tile-status" role="status">
        Coming up unavailable.
      </p>
    );
  const rows = comingUp(data, day(new Date()));
  if (!rows.length) return null;
  return (
    <section className="home-slice home-coming-up" aria-label="Coming up">
      <header>
        <h2 tabIndex={-1}>
          Coming up{" "}
          <span>
            <a href="/calendar">{rows.length}</a>
          </span>
        </h2>
      </header>
      <Fold
        label="Coming up dates"
        line={
          <>
            <strong>Coming up</strong> {counted(rows.length, "date in the next 14 days", "dates in the next 14 days")}
          </>
        }
      >
        <ul>
          {rows.map((row) => (
            <li key={row.id}>
              <a href={`/calendar?day=${row.day}`} data-home-preview>
                <time dateTime={row.day}>{weekday.format(new Date(`${row.day}T00:00:00Z`))}</time>
                <span>
                  {row.kind} <span>· {row.dealName}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      </Fold>
    </section>
  );
}
