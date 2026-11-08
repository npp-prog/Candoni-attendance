import { describe, expect, it } from 'vitest';
import { addDays, daysBetweenInclusive, isValidDate, localDate, localTime, monthRange, weekdayOf, zonedToUtc } from '../time';

describe('timezone helpers', () => {
  it('converts Manila wall time to UTC (UTC+8, no DST)', () => {
    expect(new Date(zonedToUtc('2026-03-02', 8 * 60, 'Asia/Manila')).toISOString()).toBe('2026-03-02T00:00:00.000Z');
    expect(new Date(zonedToUtc('2026-03-02', 0, 'Asia/Manila')).toISOString()).toBe('2026-03-01T16:00:00.000Z');
  });
  it('supports minutes past midnight for overnight sessions', () => {
    expect(new Date(zonedToUtc('2026-03-02', 30 * 60, 'Asia/Manila')).toISOString()).toBe('2026-03-02T22:00:00.000Z');
  });
  it('handles DST zones (America/New_York spring forward)', () => {
    // 2026-03-08 09:00 EDT = 13:00Z
    expect(new Date(zonedToUtc('2026-03-08', 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-08T13:00:00.000Z');
    expect(new Date(zonedToUtc('2026-03-07', 9 * 60, 'America/New_York')).toISOString()).toBe('2026-03-07T14:00:00.000Z');
  });
  it('formats local date and time', () => {
    const t = Date.parse('2026-03-01T17:05:00Z');
    expect(localDate(t, 'Asia/Manila')).toBe('2026-03-02');
    expect(localTime(t, 'Asia/Manila')).toBe('01:05');
    expect(localDate(t, 'UTC')).toBe('2026-03-01');
  });
  it('does date arithmetic', () => {
    expect(addDays('2026-02-28', 1)).toBe('2026-03-01');
    expect(addDays('2026-01-01', -1)).toBe('2025-12-31');
    expect(weekdayOf('2026-03-02')).toBe(1);
    expect(monthRange('2026-02')).toEqual({ from: '2026-02-01', to: '2026-02-28' });
    expect(daysBetweenInclusive('2026-02-27', '2026-03-02')).toHaveLength(4);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-02-28')).toBe(true);
  });
});
