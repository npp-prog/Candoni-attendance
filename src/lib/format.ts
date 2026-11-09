import { formatMinutes, formatTime12, localDate } from '../../shared/time';

export { formatMinutes };

export function fmtTime(ms: number | null | undefined, tz: string) {
  return ms == null ? '—' : formatTime12(ms, tz);
}

export function fmtDateTime(ms: number | null | undefined, tz: string) {
  if (ms == null) return '—';
  return new Intl.DateTimeFormat('en-PH', { timeZone: tz, dateStyle: 'medium', timeStyle: 'short' }).format(new Date(ms));
}

export function fmtDateShort(date: string) {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' }).format(new Date(Date.UTC(y, m - 1, d)));
}

/** Shows the time with "(next day)" when it falls after the work date (overnight). */
export function fmtPunch(ms: number | null | undefined, workDate: string, tz: string) {
  if (ms == null) return '—';
  const t = formatTime12(ms, tz);
  const d = localDate(ms, tz);
  if (d > workDate) return `${t} (+1d)`;
  if (d < workDate) return `${t} (−1d)`;
  return t;
}

export function fmtMeters(m: number | null | undefined) {
  if (m == null) return '—';
  return m >= 1000 ? `${(m / 1000).toFixed(2)} km` : `${Math.round(m)} m`;
}

/** Local "YYYY-MM-DDTHH:mm" for datetime-local inputs in the org timezone. */
export function toLocalInput(ms: number, tz: string) {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(ms));
  const g = (t: string) => p.find((x) => x.type === t)?.value;
  return `${g('year')}-${g('month')}-${g('day')}T${g('hour')}:${g('minute')}`;
}
