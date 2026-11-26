import { Fragment, type ReactNode, type RefObject, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import {
  DAY_WIDTH,
  dayOf,
  labelLayout,
  MIN_BAR_WIDTH,
  scale,
  spanBox,
  spentWidth,
  ZOOMS,
  type Zoom,
} from "./timeline-scale.ts";

export type TimelinePhase =
  | "pending"
  | "research"
  | "site_selection"
  | "negotiation"
  | "legal"
  | "due_diligence"
  | "closing"
  | "closed";

export type TimelinePartner = "Dell" | "Joe";

interface TimelineRowBase {
  id: string;
  name: string;
  phase: TimelinePhase;
  when?: string;
}

export type TimelineTodo = TimelineRowBase &
  (
    | { kind: "todo"; state: "done"; start: string; end: string }
    | {
        kind: "todo";
        state: "current";
        start: string;
        end?: string;
        progress?: string;
        overTypical?: boolean;
        atRisk?: boolean;
      }
    | { kind: "todo"; state: "expected"; start: string; end: string; length?: string; atRisk?: boolean }
    | { kind: "todo"; state: "stale"; start: string }
    | { kind: "todo"; state: "unrecorded" }
    | { kind: "todo"; state: "waiting" }
  );

export type TimelineStep = TimelineRowBase & { kind: "step"; owner: TimelinePartner; start: string } & (
    | { state: "done"; end: string }
    | { state: "open"; due: string }
    | { state: "undated" }
  );

export type TimelineDate = TimelineRowBase & {
  kind: "date";
  day: string;
  state: "confirmed" | "proposed" | "expected";
  atRisk?: boolean;
  detail?: string;
};

export type TimelineRow = TimelineTodo | TimelineStep | TimelineDate;
export interface TimelinePhaseBar {
  phase: TimelinePhase;
  start: string;
  end: string;
}

export interface TimelineGroup {
  id: string;
  name: string;
  count?: string;
  done?: boolean;
  bar?: TimelinePhaseBar;
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
type Tone = "default" | "late" | "soon";

const ZOOM_LABEL: Record<Zoom, string> = { day: "Day", week: "Week", month: "Month" };
const rowId = (uid: string, row: TimelineRow) => `${uid}-${row.id}`;
const foldStorage = (key: string) => `doctorcre.timeline-folds.${key}`;
const isNearDay = (day: number, now: number) => day >= now && day <= now + 7;
const optTone = (tone: Tone) => (tone === "default" ? undefined : tone);

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
const UNDATED_MIN_WIDTH = 60;
const UNDATED_TAIL_DAYS = 4;

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

const CheckIcon = ({ size, className }: { size: number; className?: string }) => (
  <svg className={className} width={size} height={size} viewBox="0 0 24 24" aria-hidden="true">
    <path d="M5 12.5l4.5 4.5L19 7.5" />
  </svg>
);

function RowGlyph({ row }: { row: TimelineRow }) {
  if (row.kind === "step") {
    return (
      <span className="timeline-owner" role="img" aria-label={row.owner}>
        {row.owner[0]}
      </span>
    );
  }
  const inner =
    row.kind === "date" ? (
      <i className="timeline-glyph-diamond" data-phase={row.phase} data-state={row.state} />
    ) : row.state === "done" ? (
      <CheckIcon size={14} className="timeline-glyph-check" />
    ) : (
      <i
        className="timeline-glyph-ring"
        data-ring={row.state === "current" || row.state === "stale" ? "current" : "dashed"}
      />
    );
  return (
    <span className="timeline-glyph" aria-hidden="true">
      {inner}
    </span>
  );
}

function rowMeta(
  row: TimelineRow,
  now: number,
): { when: string | undefined; tone: Tone; alert?: string; quiet: boolean } {
  if (row.kind === "step") {
    if (row.state === "done") return { when: row.when, tone: "default", quiet: true };
    if (row.state === "undated") return { when: row.when ?? "No date", tone: "default", quiet: false };
    const late = dayOf(row.due) < now;
    return { when: row.when, tone: late ? "late" : "default", ...(late && { alert: "Late step" }), quiet: false };
  }
  if (row.kind === "date") {
    const tone: Tone = row.atRisk
      ? "late"
      : row.state !== "expected" && isNearDay(dayOf(row.day), now)
        ? "soon"
        : "default";
    return { when: row.when, tone, ...(row.atRisk && { alert: "At risk" }), quiet: false };
  }
  if (row.state === "unrecorded" || row.state === "waiting") {
    return {
      when: row.when ?? (row.state === "unrecorded" ? "not recorded" : "no date yet"),
      tone: "default",
      quiet: true,
    };
  }
  if (row.state === "stale") return { when: row.when, tone: "soon", quiet: false };
  const atRisk = row.state !== "done" && Boolean(row.atRisk);
  return { when: row.when, tone: atRisk ? "late" : "default", ...(atRisk && { alert: "At risk" }), quiet: false };
}

function PhaseBar({ bar, start, now, px }: { bar: TimelinePhaseBar; start: number; now: number; px: number }) {
  const startDay = dayOf(bar.start);
  const { left, width } = spanBox(startDay, dayOf(bar.end), start, px);
  const spent = spentWidth(startDay, width, now, px);
  return (
    <span className="timeline-phase-bar" data-phase={bar.phase} style={{ left, width }}>
      {spent > 0 && <i className="timeline-phase-spent" style={{ width: spent }} />}
    </span>
  );
}

interface BarProps {
  mark: string;
  name: string;
  left: number;
  width: number;
  spent?: number;
  meta?: ReactNode;
  metaTone?: Tone;
  step?: boolean;
}

function Bar({ mark, name, left, width, spent, meta, metaTone = "default", step }: BarProps) {
  const { outside, showMeta } = labelLayout(name, width, Boolean(meta));
  const fullFill = spent !== undefined && spent >= width - 1;
  return (
    <div
      className={step ? "timeline-bar timeline-step" : "timeline-bar"}
      data-mark={mark}
      data-label-pos={outside ? "beside" : "inside"}
      style={{ left, width }}
    >
      {spent !== undefined && spent > 0 && (
        <i className="timeline-bar-fill" data-full={fullFill ? "" : undefined} style={{ width: spent }} />
      )}
      <span className="timeline-bar-name">{name}</span>
      {showMeta && (
        <span className="timeline-bar-meta" data-tone={optTone(metaTone)}>
          {meta}
        </span>
      )}
    </div>
  );
}

function RowMark({ row, start, now, px }: { row: TimelineRow; start: number; now: number; px: number }) {
  if (row.kind === "date") {
    const day = dayOf(row.day);
    const center = (day - start) * px + px / 2;
    const suffix = row.atRisk ? "at risk" : row.state === "proposed" ? "proposed" : undefined;
    const detail = row.detail ?? [row.when, suffix].filter(Boolean).join(" · ");
    const tone: Tone = row.atRisk ? "late" : row.state !== "expected" && isNearDay(day, now) ? "soon" : "default";
    return (
      <>
        <i
          className="timeline-diamond"
          data-mark={`date-${row.state}`}
          data-state={row.state}
          data-at-risk={row.atRisk ? "" : undefined}
          style={{ left: center }}
        />
        <span className="timeline-diamond-label" style={{ left: center + 13 }}>
          {row.name}
          {detail && (
            <span className="timeline-diamond-detail" data-tone={optTone(tone)}>
              {detail}
            </span>
          )}
        </span>
      </>
    );
  }
  if (row.kind === "step") {
    const startDay = dayOf(row.start);
    if (row.state === "undated") {
      const width = Math.max((now - startDay + UNDATED_TAIL_DAYS) * px, UNDATED_MIN_WIDTH);
      return <Bar mark="step-undated" name={row.name} left={(startDay - start) * px} width={width} step />;
    }
    const endDay = dayOf(row.state === "done" ? row.end : row.due);
    const { left, width } = spanBox(startDay, endDay, start, px);
    if (row.state === "done") return <Bar mark="step-done" name={row.name} left={left} width={width} step />;
    const lateDays = now - endDay;
    const late = lateDays > 0;
    return (
      <Bar
        mark={late ? "step-late" : "step-open"}
        name={row.name}
        left={left}
        width={width}
        meta={late ? `${lateDays}d late` : undefined}
        metaTone={late ? "late" : "default"}
        step
      />
    );
  }
  if (row.state === "unrecorded" || row.state === "waiting") return null;
  const startDay = dayOf(row.start);
  if (row.state === "stale") {
    const width = Math.max((now - startDay + 0.5) * px, MIN_BAR_WIDTH);
    return <Bar mark="todo-stale" name={row.name} left={(startDay - start) * px} width={width} spent={width} />;
  }
  if (row.state === "current" && !row.end) {
    const width = Math.max((now - startDay + 0.5) * px, MIN_BAR_WIDTH);
    return (
      <Bar
        mark="todo-current"
        name={row.name}
        left={(startDay - start) * px}
        width={width}
        spent={width}
        meta={row.progress}
      />
    );
  }
  const end = row.end;
  if (!end) return null;
  const { left, width } = spanBox(startDay, dayOf(end), start, px);
  if (row.state === "done")
    return <Bar mark="todo-done" name={row.name} left={left} width={width} meta={<CheckIcon size={12} />} />;
  if (row.state === "expected")
    return <Bar mark="todo-expected" name={row.name} left={left} width={width} meta={row.length} />;
  return (
    <Bar
      mark="todo-current"
      name={row.name}
      left={left}
      width={width}
      spent={spentWidth(startDay, width, now, px)}
      meta={row.progress}
      metaTone={row.overTypical ? "soon" : "default"}
    />
  );
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
                    <span key={d.day} className="timeline-date" style={{ left: labelCentre(d.day) }}>
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
              const heading = (
                <>
                  <span className="timeline-group-title">
                    <span className="timeline-name">{group.name}</span>
                    {group.done && <CheckIcon size={14} className="timeline-glyph-check" />}
                  </span>
                  {group.count && <span className="timeline-when">{group.count}</span>}
                </>
              );
              return (
                <Fragment key={group.id}>
                  <div className="timeline-row timeline-group" data-group={group.id}>
                    {group.rows.length > 0 ? (
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
                        {heading}
                      </button>
                    ) : (
                      <div className="timeline-label timeline-label-static">
                        <span className="timeline-chevron-gap" aria-hidden="true" />
                        {heading}
                      </div>
                    )}
                    <div className="timeline-track" style={{ width }}>
                      {group.bar && <PhaseBar bar={group.bar} start={start} now={now} px={px} />}
                    </div>
                  </div>
                  {open &&
                    group.rows.map((row) => {
                      const { when, tone, alert, quiet } = rowMeta(row, now);
                      return (
                        <div
                          key={row.id}
                          id={rowId(uid, row)}
                          className="timeline-row"
                          data-row={row.id}
                          data-quiet={quiet ? "" : undefined}
                        >
                          <div className="timeline-label">
                            <RowGlyph row={row} />
                            <span className="timeline-name">{row.name}</span>
                            {alert && (
                              <span className="timeline-alert" role="img" aria-label={alert}>
                                !
                              </span>
                            )}
                            {when && (
                              <span className="timeline-when" data-tone={optTone(tone)}>
                                {when}
                              </span>
                            )}
                          </div>
                          <div className="timeline-track" data-phase={row.phase} style={{ width }}>
                            <RowMark row={row} start={start} now={now} px={px} />
                          </div>
                        </div>
                      );
                    })}
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
