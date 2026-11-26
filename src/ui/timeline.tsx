import { Fragment, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { DAY_WIDTH, dayOf, scale, ZOOMS, type Zoom } from "./timeline-scale.ts";

export interface TimelineRow {
  id: string;
  name: string;
  when?: string;
}

export interface TimelineGroup {
  id: string;
  name: string;
  count?: string;
  startsFolded: boolean;
  rows: readonly TimelineRow[];
}

export interface TimelineProps {
  // Folds are remembered per chart, so a deal's plan and Deals Timeline keep their own.
  foldKey: string;
  today: string;
  from: string;
  to: string;
  groups: readonly TimelineGroup[];
}

type Folds = Record<string, boolean>;

const ZOOM_LABEL: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month" };
const rowId = (uid: string, row: TimelineRow) => `${uid}-${row.id}`;
const foldStorage = (key: string) => `doctorcre.timeline-folds.${key}`;

function readFolds(key: string): Folds {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(foldStorage(key)) ?? "{}");
    if (!saved || typeof saved !== "object") return {};
    return Object.fromEntries(Object.entries(saved).filter(([, folded]) => typeof folded === "boolean"));
  } catch {
    return {};
  }
}

function writeFolds(key: string, folds: Folds) {
  try {
    localStorage.setItem(foldStorage(key), JSON.stringify(folds));
  } catch {
    // A private window keeps the fold for this visit only.
  }
}

// How much of the dates is in view beside the sticky list column.
const visibleTrack = (scroller: HTMLElement | null, corner: HTMLElement | null) =>
  (scroller?.clientWidth ?? 0) - (corner?.offsetWidth ?? 0);

// Half the widest date label, so a label only touches the Today pill when its text would.
const DATE_LABEL_HALF = 12;

// Marks the chart while it is being scrolled, so the scrollbar can show only then.
function useScrollCue(scroller: RefObject<HTMLElement | null>) {
  useEffect(() => {
    const node = scroller.current;
    if (!node) return;
    const start = () => {
      node.dataset.scrolling = "";
    };
    const end = () => delete node.dataset.scrolling;
    node.addEventListener("scroll", start, { passive: true });
    node.addEventListener("scrollend", end);
    return () => {
      node.removeEventListener("scroll", start);
      node.removeEventListener("scrollend", end);
    };
  }, [scroller]);
}

function Timeline({ foldKey, today, from, to, groups }: TimelineProps) {
  // middle is the day to centre after a zoom change; null puts today a third of the way in.
  const [view, setView] = useState<{ zoom: Zoom; middle: number | null }>({ zoom: "week", middle: null });
  const [folds, setFolds] = useState(() => readFolds(foldKey));
  const scroller = useRef<HTMLElement>(null);
  const corner = useRef<HTMLDivElement>(null);
  const pill = useRef<HTMLSpanElement>(null);
  const [pillWidth, setPillWidth] = useState(0);
  const uid = useId();
  useScrollCue(scroller);
  const { zoom } = view;
  const start = dayOf(from);
  const now = dayOf(today);
  const px = DAY_WIDTH[zoom];
  const x = (day: number) => (day - start) * px;
  const { months, days, saturdays } = scale(start, dayOf(to), zoom);
  const width = x(dayOf(to));
  const labelCentre = (day: number) => x(day) + (zoom === "day" ? px / 2 : 0);
  const pillCovers = (day: number) => Math.abs(labelCentre(day) - (x(now) + px / 2)) < pillWidth / 2 + DATE_LABEL_HALF;

  useLayoutEffect(() => setPillWidth(pill.current?.offsetWidth ?? 0), []);

  useLayoutEffect(() => {
    const visible = visibleTrack(scroller.current, corner.current);
    const [day, at] = view.middle === null ? [now + 0.5, 1 / 3] : [view.middle, 1 / 2];
    scroller.current?.scrollTo({ left: Math.max(0, (day - start) * DAY_WIDTH[view.zoom] - visible * at) });
  }, [view, now, start]);

  function changeZoom(next: Zoom) {
    const left = scroller.current?.scrollLeft ?? 0;
    setView({ zoom: next, middle: start + (left + visibleTrack(scroller.current, corner.current) / 2) / px });
  }

  function toggle(group: TimelineGroup) {
    const next = { ...folds, [group.id]: !(folds[group.id] ?? group.startsFolded) };
    setFolds(next);
    writeFolds(foldKey, next);
  }

  return (
    <section className="timeline" data-day-width={px}>
      <p className="timeline-sr">
        The chart runs from {from} to {to}. Today is {today}.
      </p>
      <div className="timeline-tools">
        <fieldset className="timeline-zoom" aria-label="Zoom">
          {ZOOMS.map((z) => (
            <button key={z} type="button" aria-pressed={z === zoom} onClick={() => changeZoom(z)}>
              {ZOOM_LABEL[z]}
            </button>
          ))}
        </fieldset>
        <button type="button" onClick={() => setView({ zoom, middle: null })}>
          <svg width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
            <circle cx="12" cy="12" r="8" />
            <path d="M12 2v4M12 18v4M2 12h4M18 12h4" />
          </svg>
          Today
        </button>
      </div>
      <section className="timeline-scroll" ref={scroller} aria-label="Timeline">
        <div className="timeline-canvas">
          <div className="timeline-head">
            <div className="timeline-corner" ref={corner} />
            <div className="timeline-dates" style={{ width }} aria-hidden="true">
              {months.map((m, i) => (
                <div
                  key={m.day}
                  className="timeline-month"
                  style={{ left: x(m.day), width: x(months[i + 1]?.day ?? dayOf(to)) - x(m.day) }}
                >
                  <span>{m.label}</span>
                </div>
              ))}
              {days.map(
                (d) =>
                  !pillCovers(d.day) && (
                    <span
                      key={d.day}
                      className="timeline-date"
                      style={{ left: x(d.day) + (zoom === "day" ? px / 2 : 0) }}
                    >
                      {d.label}
                    </span>
                  ),
              )}
              <span ref={pill} className="timeline-today" style={{ left: x(now) + px / 2 }}>
                Today
              </span>
            </div>
          </div>
          <div className="timeline-body">
            <div className="timeline-grid" aria-hidden="true">
              {saturdays.map((d) => (
                <i
                  key={d}
                  className="timeline-weekend"
                  style={{ left: Math.max(0, x(d)), width: Math.min(x(d) + 2 * px, 2 * px) }}
                />
              ))}
              {months
                .filter((m) => m.day > start)
                .map((m) => (
                  <i key={m.day} className="timeline-month-line" style={{ left: x(m.day) }} />
                ))}
              <i className="timeline-now" style={{ left: x(now) + px / 2 }} />
            </div>
            {groups.map((group) => {
              const open = !(folds[group.id] ?? group.startsFolded);
              return (
                <Fragment key={group.id}>
                  <div className="timeline-row timeline-group" data-group={group.id}>
                    <button
                      type="button"
                      className="timeline-label"
                      aria-expanded={open}
                      aria-controls={open ? group.rows.map((row) => rowId(uid, row)).join(" ") : undefined}
                      onClick={() => toggle(group)}
                    >
                      <svg className="timeline-chevron" width="16" height="16" viewBox="0 0 24 24" aria-hidden="true">
                        <path d="M10 6l6 6-6 6" />
                      </svg>
                      <span className="timeline-name">{group.name}</span>
                      {group.count && <span className="timeline-when">{group.count}</span>}
                    </button>
                  </div>
                  {open &&
                    group.rows.map((row) => (
                      <div key={row.id} id={rowId(uid, row)} className="timeline-row" data-row={row.id}>
                        <div className="timeline-label">
                          <span className="timeline-name">{row.name}</span>
                          {row.when && <span className="timeline-when">{row.when}</span>}
                        </div>
                      </div>
                    ))}
                </Fragment>
              );
            })}
            <div className="timeline-list-fill" />
          </div>
        </div>
      </section>
    </section>
  );
}

export function mountTimeline(host: HTMLElement, initial: TimelineProps) {
  const root = createRoot(host);
  let disposed = false;
  function update(props: TimelineProps) {
    if (disposed) return;
    flushSync(() => root.render(<Timeline key={props.foldKey} {...props} />));
  }
  update(initial);
  return {
    update,
    dispose() {
      if (disposed) return;
      disposed = true;
      root.unmount();
    },
  };
}
