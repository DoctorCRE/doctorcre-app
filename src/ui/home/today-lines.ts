import { centralToday } from "../central-time.ts";

export type Meeting = Record<string, unknown> & { key: string | null; title: string; start: string; end: string };
type Review = Meeting & { key: string };
export type MeetingRow = { id: string; meeting: Meeting; reviewed: boolean };

const lastDay = (meeting: Meeting) =>
  centralToday(new Date(Math.max(Date.parse(meeting.start), Date.parse(meeting.end) - 1)));
export const onDay = (meeting: Meeting, today: string) =>
  centralToday(new Date(meeting.start)) <= today && lastDay(meeting) >= today;
export const ended = (meeting: Meeting, now: number) => meeting.all_day !== true && Date.parse(meeting.end) <= now;

/**
 * Today's meetings in time order, all-day ones first. A review for today with no calendar row shows
 * its own title and times. A row whose review was answered stays through the day even when Outlook's
 * next snapshot drops the ended meeting.
 */
export function meetingRows(
  read: { items: Meeting[]; reviews: Review[] },
  today: string,
  revision: number,
  previous: readonly MeetingRow[],
): MeetingRow[] {
  const rows = new Map<string, MeetingRow>();
  for (const [index, meeting] of read.items.entries())
    if (onDay(meeting, today)) {
      const id = meeting.key ?? `unkeyed:${revision}:${index}`;
      rows.set(id, { id, meeting, reviewed: false });
    }
  for (const review of read.reviews) {
    const listed = rows.get(review.key);
    if (listed) rows.set(review.key, { ...listed, reviewed: true });
    else if (onDay(review, today)) rows.set(review.key, { id: review.key, meeting: review, reviewed: true });
  }
  for (const old of previous) {
    if (!old.reviewed) continue;
    const current = rows.get(old.id);
    if (current) rows.set(old.id, { ...current, reviewed: true });
    else if (onDay(old.meeting, today)) rows.set(old.id, old);
  }
  const order = (row: MeetingRow) => (row.meeting.all_day === true ? -Infinity : Date.parse(row.meeting.start));
  return [...rows.values()].sort((a, b) => order(a) - order(b));
}

/** Where the current-time line sits: before the first timed meeting that has not started. */
export function nowLine(rows: readonly MeetingRow[], now: number) {
  const next = rows.findIndex(({ meeting }) => meeting.all_day !== true && Date.parse(meeting.start) > now);
  return next === -1 ? rows.length : next;
}

/** The next moment a meeting starts or ends, when the tile must redraw. */
export function nextChange(rows: readonly MeetingRow[], now: number) {
  return Math.min(
    ...rows.flatMap(({ meeting }) => [Date.parse(meeting.start), Date.parse(meeting.end)].filter((at) => at > now)),
  );
}
