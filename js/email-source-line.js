import { BUSINESS_TIME_ZONE } from './business-date.js';

const parse = value => {
  if (typeof value !== 'string') return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})[Tt](\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:[Zz]|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match || match[0] !== value) return null;
  const [, year, month, day, hour, minute, second, , offsetHour = '0', offsetMinute = '0'] = match;
  const leap = +year % 4 === 0 && (+year % 100 !== 0 || +year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  if (+month < 1 || +month > 12 || +day < 1 || +day > days[+month - 1]
    || +hour > 23 || +minute > 59 || +second > 59 || +offsetHour > 23 || +offsetMinute > 59) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
};
export function relativeAge(occurredAt, now = new Date()) {
  const sent = parse(occurredAt);
  if (!sent) return 'time unavailable';
  const minutes = Math.max(0, Math.floor((now.getTime() - sent.getTime()) / 60000));
  return minutes < 1 ? 'just now' : minutes < 60 ? `${minutes}m ago`
    : minutes < 1440 ? `${Math.floor(minutes / 60)}h ago` : `${Math.floor(minutes / 1440)}d ago`;
}

export function sourceTime(occurredAt, now = new Date(), missing = 'Time unavailable') {
  const sent = parse(occurredAt);
  if (!sent) return missing;
  const year = date => date.toLocaleDateString('en-US', { timeZone: BUSINESS_TIME_ZONE, year: 'numeric' });
  return sent.toLocaleString('en-US', { timeZone: BUSINESS_TIME_ZONE, month: 'short', day: 'numeric',
    ...(year(sent) === year(now) ? {} : { year: 'numeric' }), hour: 'numeric', minute: '2-digit' });
}

export function waitingDays(occurredAt, now = new Date()) {
  const sent = parse(occurredAt);
  if (!sent) return 'Waiting time unavailable';
  const days = Math.max(0, Math.floor((now.getTime() - sent.getTime()) / 86400000));
  return `${days} ${days === 1 ? 'day' : 'days'} waiting`;
}

const origins = new Map([
  ['call', 'From a call'],
  ['email', 'From an email'],
  ['meeting', 'From a meeting'],
  ['cadence', 'From the automatic follow-up schedule'],
]);

/** @param {{set_by?: string | null, set_at?: string | null, set_from?: string | null} | null | undefined} step */
export function stepOriginLabel(step, { showDateOnly = false } = {}) {
  const at = sourceTime(step?.set_at, undefined, '');
  const by = typeof step?.set_by === 'string' ? step.set_by : '';
  const from = origins.get(step?.set_from ?? '');
  if (!at || (!by && !from && !showDateOnly)) return '';
  const set = by ? `Set by ${by} · ${at}` : `Set ${at}`;
  return from ? `${set} · ${from}` : set;
}
