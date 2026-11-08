/**
 * Timezone helpers built on Intl (no external dependencies). All instants are
 * UTC epoch milliseconds; "local" means the organization timezone.
 */

const dtfCache = new Map<string, Intl.DateTimeFormat>();

function partsFormatter(tz: string): Intl.DateTimeFormat {
  let f = dtfCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      weekday: 'short',
    });
    dtfCache.set(tz, f);
  }
  return f;
}

export function isValidTimeZone(tz: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

interface LocalParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

export function localParts(epochMs: number, tz: string): LocalParts {
  const parts = partsFormatter(tz).formatToParts(new Date(epochMs));
  const get = (t: string) => Number(parts.find((p) => p.type === t)?.value);
  return {
    year: get('year'),
    month: get('month'),
    day: get('day'),
    hour: get('hour') % 24,
    minute: get('minute'),
    second: get('second'),
  };
}

/** Offset of the timezone from UTC at the given instant, in milliseconds. */
export function tzOffsetMs(epochMs: number, tz: string): number {
  const p = localParts(epochMs, tz);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return asUtc - Math.floor(epochMs / 1000) * 1000;
}

const pad = (n: number) => String(n).padStart(2, '0');

export function localDate(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  return `${p.year}-${pad(p.month)}-${pad(p.day)}`;
}

export function localTime(epochMs: number, tz: string): string {
  const p = localParts(epochMs, tz);
  return `${pad(p.hour)}:${pad(p.minute)}`;
}

export const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export function isValidDate(d: string): boolean {
  if (!DATE_RE.test(d)) return false;
  const [y, m, day] = d.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, day));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === day;
}

export function parseHHmm(t: string): number {
  if (!TIME_RE.test(t)) throw new Error(`Invalid time "${t}"`);
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + days));
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`;
}

/** 0 = Sunday ... 6 = Saturday, for a calendar date (timezone independent). */
export function weekdayOf(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d)).getUTCDay();
}

export function daysBetweenInclusive(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    out.push(d);
    if (out.length > 400) throw new Error('Date range too large');
  }
  return out;
}

/**
 * Converts a local wall-clock time (date + minutes since local midnight, which
 * may exceed 1440 for times on following days) into a UTC instant.
 * For DST gaps the result is shifted forward; for overlaps the earlier instant is used.
 */
export function zonedToUtc(date: string, minutesFromMidnight: number, tz: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const naive = Date.UTC(y, m - 1, d, 0, 0, 0) + minutesFromMidnight * 60_000;
  let guess = naive - tzOffsetMs(naive, tz);
  // Two refinement passes settle the offset around DST transitions.
  for (let i = 0; i < 2; i++) {
    const next = naive - tzOffsetMs(guess, tz);
    if (next === guess) break;
    guess = next;
  }
  return guess;
}

export function monthRange(month: string): { from: string; to: string } {
  const [y, m] = month.split('-').map(Number);
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { from: `${y}-${pad(m)}-01`, to: `${y}-${pad(m)}-${pad(last)}` };
}

export function formatTime12(epochMs: number, tz: string): string {
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: tz,
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  }).format(new Date(epochMs));
}

export function formatDateLong(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Intl.DateTimeFormat('en-PH', {
    timeZone: 'UTC',
    weekday: 'long',
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  }).format(new Date(Date.UTC(y, m - 1, d)));
}

export function formatMinutes(min: number): string {
  if (!min) return '0m';
  const h = Math.floor(min / 60);
  const m = min % 60;
  return h ? `${h}h ${pad(m)}m` : `${m}m`;
}
