import { centralInstant, centralToday } from "../central-time.ts";

// Days are "YYYY-MM-DD" strings stepped in UTC, so no local clock shifts them.
const utc = (day: string) => new Date(`${day}T00:00:00Z`);
const iso = (date: Date) => date.toISOString().slice(0, 10);
const addDays = (day: string, count: number) => iso(new Date(utc(day).getTime() + count * 86_400_000));

/** A snooze returns at 8:00 AM Central on the chosen day. */
export const snoozeUntil = (day: string) => centralInstant(`${day}T08:00`);

export const snoozeTomorrow = (now: Date) => addDays(centralToday(now), 1);

/** The coming Monday; on a Monday, the one after. */
export function snoozeNextWeek(now: Date) {
  const today = centralToday(now);
  return addDays(today, (8 - weekday(today)) % 7 || 7);
}

export const canSnoozeTo = (day: string, now: Date) => Date.parse(snoozeUntil(day)) > now.getTime();

/** The first of the month `count` months after the month holding `day`. */
export function monthStart(day: string, count = 0) {
  const date = utc(day);
  return iso(new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth() + count, 1)));
}

export const weekday = (day: string) => utc(day).getUTCDay();

/** Every day of the month that starts on `first`. */
export function monthDays(first: string) {
  const length = (utc(monthStart(first, 1)).getTime() - utc(first).getTime()) / 86_400_000;
  return Array.from({ length }, (_, index) => addDays(first, index));
}
