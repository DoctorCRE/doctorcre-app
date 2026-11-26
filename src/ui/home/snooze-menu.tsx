import { useState } from "react";
import { centralToday } from "../central-time.ts";
import {
  canSnoozeTo,
  monthDays,
  monthStart,
  snoozeNextWeek,
  snoozeTomorrow,
  snoozeUntil,
  weekday,
} from "./snooze-times.ts";

const WEEKDAYS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
const dayName = new Intl.DateTimeFormat("en-US", {
  timeZone: "UTC",
  weekday: "short",
  month: "short",
  day: "numeric",
});
const fullDay = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", dateStyle: "full" });
const monthName = new Intl.DateTimeFormat("en-US", { timeZone: "UTC", month: "long", year: "numeric" });
const noon = (day: string) => new Date(`${day}T12:00:00Z`);

/** Tomorrow, Next week, or any later day on a month calendar; each returns at 8:00 AM Central. */
export function SnoozeMenu({
  count,
  error,
  choose,
  cancel,
}: Readonly<{ count: number; error: string; choose: (day: string) => void; cancel: () => void }>) {
  const [now] = useState(() => new Date());
  const today = centralToday(now);
  const thisMonth = monthStart(today);
  const [month, setMonth] = useState(thisMonth);
  const quick = [
    ["Tomorrow", snoozeTomorrow(now)],
    ["Next week", snoozeNextWeek(now)],
  ] as const;
  return (
    <dialog
      className="inbox-snooze snooze-menu"
      ref={(node) => {
        if (node && !node.open) node.showModal();
      }}
      onCancel={cancel}
      aria-label="Snooze cards"
    >
      <h2>Snooze {count === 1 ? "card" : `${count} cards`}</h2>
      <p>Returns to your inbox at 8:00 AM.</p>
      {error && <p role="alert">{error}</p>}
      <div className="snooze-quick">
        {quick.map(([label, day], index) => (
          <button
            type="button"
            key={label}
            ref={(button) => {
              if (index === 0) button?.focus();
            }}
            onClick={() => choose(day)}
          >
            <span>{label}</span>
            <time dateTime={snoozeUntil(day)}>{dayName.format(noon(day))}</time>
          </button>
        ))}
      </div>
      <section className="snooze-month" aria-label="Pick a date">
        <header>
          <button
            type="button"
            aria-label="Previous month"
            disabled={month <= thisMonth}
            onClick={() => setMonth(monthStart(month, -1))}
          >
            ‹
          </button>
          <h3 aria-live="polite">{monthName.format(noon(month))}</h3>
          <button type="button" aria-label="Next month" onClick={() => setMonth(monthStart(month, 1))}>
            ›
          </button>
        </header>
        <div className="snooze-days">
          {WEEKDAYS.map((weekday) => (
            <span key={weekday} aria-hidden="true">
              {weekday}
            </span>
          ))}
          {monthDays(month).map((day, index) => (
            <button
              type="button"
              key={day}
              style={index ? undefined : { gridColumnStart: weekday(day) + 1 }}
              aria-label={fullDay.format(noon(day))}
              aria-current={day === today ? "date" : undefined}
              disabled={!canSnoozeTo(day, now)}
              onClick={() => choose(day)}
            >
              {Number(day.slice(8))}
            </button>
          ))}
        </div>
      </section>
      <button type="button" onClick={cancel}>
        Cancel
      </button>
    </dialog>
  );
}
