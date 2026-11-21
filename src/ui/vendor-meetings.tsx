import { useEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import type { MeetingPage, MeetingQuery } from "./vendor-meetings-client.ts";
import { parseMeetingPage, researchReason } from "./vendor-meetings-client.ts";

type Options = {
  load: (query: MeetingQuery, signal: AbortSignal) => Promise<unknown>;
  href: (id: string) => string;
  nameLabel: (text: string) => string;
  phoneLabel: (phone: string) => string;
  timeLabel: (instant: string) => string;
  open: (href: string, returnFocusId: string) => void;
};
type State = { kind: "loading" } | { kind: "failed" } | { kind: "ready"; page: MeetingPage };
function VendorMeetings({ options }: { options: Options }) {
  const [query, setQuery] = useState<MeetingQuery>({ view: "suggested", q: "", limit: 5 });
  const [state, setState] = useState<State>({ kind: "loading" });
  const generation = useRef(0);
  const tabs = useRef<(HTMLButtonElement | null)[]>([]);
  const active = useRef<AbortController | null>(null);
  function change(next: MeetingQuery) {
    generation.current++;
    active.current?.abort();
    setState({ kind: "loading" });
    setQuery(next);
  }
  useEffect(() => {
    const ticket = ++generation.current;
    const controller = new AbortController();
    active.current = controller;
    // eslint-disable-next-line no-restricted-syntax -- One 350 ms search debounce per panel, cancelled on query change or unmount.
    const timer = setTimeout(
      () => {
        void options
          .load(query, controller.signal)
          .then((value) => {
            if (ticket !== generation.current || controller.signal.aborted) return;
            const page = parseMeetingPage(value, query);
            setState({ kind: "ready", page });
          })
          .catch(() => {
            if (ticket === generation.current && !controller.signal.aborted) setState({ kind: "failed" });
          });
      },
      query.q ? 350 : 0,
    );
    return () => {
      clearTimeout(timer);
      controller.abort();
      generation.current++;
    };
  }, [options, query]);
  return (
    <section aria-label="People worth meeting">
      <div role="tablist" aria-label="Vendor meetings">
        {(["suggested", "research"] satisfies MeetingQuery["view"][]).map((view, index) => (
          <button
            key={view}
            ref={(node) => {
              tabs.current[index] = node;
            }}
            type="button"
            role="tab"
            id={`vendor-meetings-${view}`}
            aria-controls="vendor-meetings-results"
            aria-selected={query.view === view}
            tabIndex={query.view === view ? 0 : -1}
            onClick={() => {
              if (query.view !== view) change({ view, q: query.q, limit: 5 });
            }}
            onKeyDown={(event) => {
              const target =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? 1
                    : event.key === "ArrowLeft" || event.key === "ArrowRight"
                      ? 1 - index
                      : null;
              if (target === null) return;
              event.preventDefault();
              tabs.current[target]?.click();
              tabs.current[target]?.focus();
            }}
          >
            {view === "suggested" ? "Suggested" : "Research"}
          </button>
        ))}
      </div>
      <label className="field">
        Search people and offices
        <input
          type="search"
          maxLength={80}
          value={query.q}
          onChange={(event) => change({ view: query.view, q: event.currentTarget.value, limit: 5 })}
        />
      </label>
      <div
        role="tabpanel"
        id="vendor-meetings-results"
        aria-labelledby={`vendor-meetings-${query.view}`}
        aria-busy={state.kind === "loading"}
      >
        {state.kind === "loading" && <p role="status">Loading people…</p>}
        {state.kind === "failed" && (
          <>
            <p role="alert">People could not be loaded. Try again.</p>
            <button
              type="button"
              className="action"
              onClick={() => {
                generation.current++;
                setState({ kind: "loading" });
                setQuery({ ...query });
              }}
            >
              Retry people
            </button>
          </>
        )}
        {state.kind === "ready" && (
          <>
            {state.page.calendar.state === "partial" && <p role="status">Calendar incomplete</p>}
            {state.page.items.length === 0 && (
              <p>{query.view === "suggested" ? "No suggested people" : "No people need research"}</p>
            )}
            <ul className="vendor-meetings-list">
              {state.page.items.map((row, index) => (
                <li
                  key={`${row.vendor_id}-${row.contact?.id ?? "company"}`}
                  data-meeting-person={row.contact?.id ?? ""}
                >
                  <a
                    id={`vendor-meeting-person-${index}`}
                    href={options.href(row.vendor_id)}
                    onClick={(event) => {
                      if (event.button !== 0 || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)
                        return;
                      event.preventDefault();
                      options.open(event.currentTarget.href, event.currentTarget.id);
                    }}
                  >
                    {options.nameLabel(row.contact?.name || row.company?.name || "Open vendor")}
                  </a>
                  {row.contact && row.company && <p>{options.nameLabel(row.company.name)}</p>}
                  {row.office && (
                    <p data-meeting-office>
                      {row.office.street_address}, {row.office.city}, {row.office.state}
                    </p>
                  )}
                  {row.reason && <p data-meeting-reason>{options.nameLabel(row.reason)}</p>}
                  {row.contact?.email && <p>{row.contact.email}</p>}
                  {(row.contact?.phone || row.contact?.cell) && (
                    <p data-meeting-phone>{options.phoneLabel(row.contact.phone || row.contact.cell || "")}</p>
                  )}
                  {row.missing.length > 0 && (
                    <ul aria-label="Research needed">
                      {row.missing.map((reason) => (
                        <li key={reason}>{researchReason(reason)}</li>
                      ))}
                    </ul>
                  )}
                  {row.possible_meetings.length > 0 && (
                    <>
                      <h3>Possible meetings</h3>
                      <ul>
                        {row.possible_meetings.map((meeting) => (
                          <li key={`${meeting.title}-${meeting.start}-${meeting.end}-${meeting.location}`}>
                            {meeting.title} · <time dateTime={meeting.start}>{options.timeLabel(meeting.start)}</time>{" "}
                            to <time dateTime={meeting.end}>{options.timeLabel(meeting.end)}</time>
                            {meeting.location ? ` · ${meeting.location}` : ""}
                          </li>
                        ))}
                      </ul>
                    </>
                  )}
                </li>
              ))}
            </ul>
            {state.page.has_more && (
              <button
                type="button"
                className="action"
                onClick={() => {
                  if (state.page.next_cursor) change({ ...query, cursor: state.page.next_cursor });
                }}
              >
                Next people
              </button>
            )}
            {query.cursor && (
              <button
                type="button"
                className="action"
                onClick={() => change({ view: query.view, q: query.q, limit: 5 })}
              >
                Back to first people
              </button>
            )}
          </>
        )}
      </div>
    </section>
  );
}
export function mountVendorMeetings(host: HTMLElement, options: Options) {
  const root = createRoot(host);
  let disposed = false;
  const dispose = () => {
    if (disposed) return;
    disposed = true;
    window.removeEventListener("doctorcre-session-invalidated", dispose);
    flushSync(() => root.unmount());
  };
  window.addEventListener("doctorcre-session-invalidated", dispose);
  flushSync(() =>
    root.render(
      <details className="module-card glass vendor-meetings" open={!window.matchMedia("(max-width: 767px)").matches}>
        <summary>
          <h2>People worth meeting</h2>
        </summary>
        <VendorMeetings options={options} />
      </details>,
    ),
  );
  return { dispose };
}
