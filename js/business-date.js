export const BUSINESS_TIME_ZONE = 'America/Chicago';
const dayFormat = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit' });

const zoneName = (date, timeZone) => new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'short' })
  .formatToParts(date).find(part => part.type === 'timeZoneName')?.value;

/** A clock time. Both partners work in Central, so only a time shown in another zone names its zone. */
export const meetingTime = (value, timeZone, { date = false } = {}) => {
  const instant = new Date(value);
  return new Intl.DateTimeFormat('en-US', {
    timeZone, ...(date ? { month: 'short', day: 'numeric' } : {}), hour: 'numeric', minute: '2-digit', hour12: true,
    ...(zoneName(instant, timeZone) === zoneName(instant, BUSINESS_TIME_ZONE) ? {} : { timeZoneName: 'short' }),
  }).format(instant);
};

export function businessDay(now = new Date()) {
  const parts = Object.fromEntries(dayFormat.formatToParts(now).map(({type,value}) => [type,value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

export function overnightCutoff(now = new Date()) {
  const previous = new Date(`${businessDay(now)}T00:00:00Z`);
  previous.setUTCDate(previous.getUTCDate() - 1);
  const target = new Date(`${previous.toISOString().slice(0,10)}T17:00:00Z`);
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: BUSINESS_TIME_ZONE, year:'numeric', month:'2-digit', day:'2-digit', hour:'2-digit', minute:'2-digit', second:'2-digit', hourCycle:'h23' }).formatToParts(target);
  const values = Object.fromEntries(parts.map(({type,value}) => [type,value]));
  const wall = Date.parse(`${values.year}-${values.month}-${values.day}T${values.hour}:${values.minute}:${values.second}Z`);
  return new Date(target.valueOf() + target.valueOf() - wall).toISOString();
}
