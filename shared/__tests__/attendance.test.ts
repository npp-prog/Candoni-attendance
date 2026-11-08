import { describe, expect, it } from 'vitest';
import { computeDay, determineNextAction, effectivePunches, type Punches } from '../attendance';
import { assignmentForDate, buildShiftPlan, validateSchedule } from '../schedule';
import { zonedToUtc } from '../time';
import type { ScheduleDoc, ShiftPlan } from '../types';

const TZ = 'Asia/Manila';
const at = (date: string, hhmm: string, dayOffset = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToUtc(date, dayOffset * 1440 + h * 60 + m, TZ);
};

const baseSchedule: ScheduleDoc = {
  id: 'reg', name: 'Regular 8-5', pattern: 'single', sessions: [{ start: '08:00', end: '17:00' }],
  workDays: [1, 2, 3, 4, 5], graceMinutes: 15, breakStart: '12:00', breakEnd: '13:00', flexible: false, flexMinutes: 0,
  earlyInMinutes: 120, cutoffMinutes: 240, overtimeThresholdMinutes: 30, active: true,
};
const split: ScheduleDoc = { ...baseSchedule, id: 'split', name: 'AM/PM', pattern: 'split', sessions: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], breakStart: null, breakEnd: null };
const night: ScheduleDoc = { ...baseSchedule, id: 'night', name: 'Night 22-06', sessions: [{ start: '22:00', end: '06:00' }], breakStart: '02:00', breakEnd: '03:00', workDays: [0, 1, 2, 3, 4, 5, 6] };
const flex: ScheduleDoc = { ...baseSchedule, id: 'flex', name: 'Flex', flexible: true, flexMinutes: 120, graceMinutes: 0 };

const MON = '2026-03-02';
const plan = (s: ScheduleDoc | null, date = MON, holiday: string | null = null) =>
  buildShiftPlan({ date, tz: TZ, schedule: s, holiday: holiday ? { id: 'h', date, name: holiday, type: 'regular' } : null });
const ctx = (now: number, extra = {}) => ({ now, onLeave: false, hasFieldwork: false, ...extra });

const plansAround = (s: ScheduleDoc | null, today: string) => ({
  yesterday: plan(s, addDays(today, -1)), today: plan(s, today), tomorrow: plan(s, addDays(today, 1)),
});
function addDays(d: string, n: number) { const [y, m, dd] = d.split('-').map(Number); const x = new Date(Date.UTC(y, m - 1, dd + n)); return x.toISOString().slice(0, 10); }
const next = (s: ScheduleDoc | null, today: string, now: number, punches: Record<string, Punches> = {}, allowUnscheduled = true) =>
  determineNextAction({ now, plans: plansAround(s, today), punches, allowUnscheduled, unscheduledMaxHours: 16, minActionIntervalSeconds: 60 });

describe('schedule plans', () => {
  it('builds a regular workday plan with window and break', () => {
    const p = plan(baseSchedule);
    expect(p.kind).toBe('workday');
    expect(p.sessions[0].start).toBe(at(MON, '08:00'));
    expect(p.windowOpen).toBe(at(MON, '06:00'));
    expect(p.windowClose).toBe(at(MON, '21:00'));
    expect(p.breakWindow?.start).toBe(at(MON, '12:00'));
  });
  it('marks rest days and holidays', () => {
    expect(plan(baseSchedule, '2026-03-01').kind).toBe('rest_day');
    expect(plan(baseSchedule, MON, 'Founders Day').kind).toBe('holiday');
    expect(plan(null).kind).toBe('no_schedule');
  });
  it('places overnight sessions and breaks on the next calendar day', () => {
    const p = plan(night);
    expect(p.sessions[0].end).toBe(at(MON, '06:00', 1));
    expect(p.breakWindow?.start).toBe(at(MON, '02:00', 1));
  });
  it('validates schedule definitions', () => {
    expect(validateSchedule(baseSchedule)).toBeNull();
    expect(validateSchedule({ ...split, sessions: [{ start: '08:00', end: '12:00' }] })).toMatch(/exactly 2/);
    expect(validateSchedule({ ...baseSchedule, graceMinutes: -1 })).toMatch(/graceMinutes/);
  });
  it('resolves effective-dated assignments', () => {
    const as = [
      { id: 'a1', memberId: 'm', scheduleId: 'reg', effectiveFrom: '2026-01-01', effectiveTo: null },
      { id: 'a2', memberId: 'm', scheduleId: 'night', effectiveFrom: '2026-03-01', effectiveTo: '2026-03-31' },
    ];
    expect(assignmentForDate(as, '2026-02-15')?.scheduleId).toBe('reg');
    expect(assignmentForDate(as, '2026-03-15')?.scheduleId).toBe('night');
    expect(assignmentForDate(as, '2026-04-01')?.scheduleId).toBe('reg');
    expect(assignmentForDate(as, '2025-12-31')).toBeNull();
  });
});

describe('next action sequencing', () => {
  it('only offers clock-in first, then clock-out', () => {
    expect(next(baseSchedule, MON, at(MON, '07:50')).action).toBe('IN');
    const r = next(baseSchedule, MON, at(MON, '17:01'), { [MON]: { IN: at(MON, '07:50') } });
    expect(r.action).toBe('OUT');
    expect(r.code).toBe('OK');
  });
  it('rejects too-early and closed windows with reasons', () => {
    const early = next(baseSchedule, MON, at(MON, '05:00'));
    expect(early.code).toBe('TOO_EARLY');
    expect(early.availableAt).toBe(at(MON, '06:00'));
    expect(next(baseSchedule, MON, at(MON, '21:30')).code).toBe('SHIFT_CLOSED');
  });
  it('reports a completed shift', () => {
    expect(next(baseSchedule, MON, at(MON, '18:00'), { [MON]: { IN: at(MON, '08:00'), OUT: at(MON, '17:00') } }).code).toBe('SHIFT_COMPLETE');
  });
  it('blocks double submissions inside the minimum interval', () => {
    const r = next(baseSchedule, MON, at(MON, '08:00') + 30_000, { [MON]: { IN: at(MON, '08:00') } });
    expect(r.code).toBe('TOO_SOON');
  });
  it('sequences AM In, AM Out, PM In, PM Out', () => {
    expect(next(split, MON, at(MON, '07:55')).action).toBe('AM_IN');
    expect(next(split, MON, at(MON, '12:00'), { [MON]: { AM_IN: at(MON, '07:55') } }).action).toBe('AM_OUT');
    expect(next(split, MON, at(MON, '12:55'), { [MON]: { AM_IN: at(MON, '07:55'), AM_OUT: at(MON, '12:00') } }).action).toBe('PM_IN');
    expect(next(split, MON, at(MON, '17:00'), { [MON]: { AM_IN: 1, AM_OUT: 2, PM_IN: at(MON, '12:55') } }).action).toBe('PM_OUT');
  });
  it('starts at PM In when the AM session was missed', () => {
    expect(next(split, MON, at(MON, '12:45')).action).toBe('PM_IN');
  });
  it('assigns overnight clock-out after midnight to the shift start date', () => {
    const tue = '2026-03-03';
    const r = next(night, tue, at(MON, '06:05', 1), { [MON]: { IN: at(MON, '21:55') } });
    expect(r.action).toBe('OUT');
    expect(r.workDate).toBe(MON);
  });
  it('assigns a late overnight clock-in after midnight to the previous work date', () => {
    const tue = '2026-03-03';
    const r = next(night, tue, at(MON, '00:30', 1));
    expect(r.action).toBe('IN');
    expect(r.workDate).toBe(MON);
  });
  it('treats rest-day attendance as unscheduled when allowed, and blocks it otherwise', () => {
    const sun = '2026-03-01';
    const r = next(baseSchedule, sun, at(sun, '09:00'));
    expect(r.action).toBe('IN');
    expect(r.plan.unscheduled).toBe(true);
    expect(next(baseSchedule, sun, at(sun, '09:00'), {}, false).code).toBe('NOT_SCHEDULED');
  });
  it('lets an unscheduled shift clock out after midnight', () => {
    const sun = '2026-03-01';
    const r = next(baseSchedule, MON, at(sun, '01:00', 1), { [sun]: { IN: at(sun, '20:00') } });
    expect(r.action).toBe('OUT');
    expect(r.workDate).toBe(sun);
  });
});

describe('daily computation', () => {
  const p = plan(baseSchedule);
  const end = at(MON, '23:00');
  it('computes on-time full day with break deduction', () => {
    const r = computeDay(p, { IN: at(MON, '07:58'), OUT: at(MON, '17:00') }, ctx(end));
    expect(r.status).toBe('completed');
    expect(r.lateMinutes).toBe(0);
    expect(r.undertimeMinutes).toBe(0);
    expect(r.workedMinutes).toBe(9 * 60 + 2 - 60);
  });
  it('applies the grace period at minute precision', () => {
    expect(computeDay(p, { IN: at(MON, '08:15') + 59_000, OUT: at(MON, '17:00') }, ctx(end)).lateMinutes).toBe(0);
    const r = computeDay(p, { IN: at(MON, '08:16'), OUT: at(MON, '17:00') }, ctx(end));
    expect(r.lateMinutes).toBe(16);
    expect(r.exceptions).toContain('LATE');
  });
  it('computes undertime and partial break overlap', () => {
    const r = computeDay(p, { IN: at(MON, '08:00'), OUT: at(MON, '12:30') }, ctx(end));
    expect(r.undertimeMinutes).toBe(270);
    expect(r.workedMinutes).toBe(240);
  });
  it('flags potential overtime only past the threshold', () => {
    expect(computeDay(p, { IN: at(MON, '08:00'), OUT: at(MON, '17:29') }, ctx(end)).overtimeCandidateMinutes).toBe(0);
    expect(computeDay(p, { IN: at(MON, '08:00'), OUT: at(MON, '18:00') }, ctx(end)).overtimeCandidateMinutes).toBe(60);
  });
  it('does not mark absent before the cutoff, and does after', () => {
    expect(computeDay(p, {}, ctx(at(MON, '07:00'))).status).toBe('upcoming');
    expect(computeDay(p, {}, ctx(at(MON, '10:00'))).status).toBe('awaiting');
    expect(computeDay(p, {}, ctx(at(MON, '20:59'))).status).toBe('awaiting');
    const r = computeDay(p, {}, ctx(at(MON, '21:01')));
    expect(r.status).toBe('absent');
    expect(r.exceptions).toContain('ABSENT');
  });
  it('distinguishes leave, holiday, rest day and fieldwork from absence', () => {
    expect(computeDay(p, {}, ctx(end, { onLeave: true })).status).toBe('leave');
    expect(computeDay(plan(baseSchedule, MON, 'Holiday'), {}, ctx(end)).status).toBe('holiday');
    expect(computeDay(plan(baseSchedule, '2026-03-01'), {}, ctx(end)).status).toBe('rest_day');
    expect(computeDay(p, {}, ctx(end, { hasFieldwork: true })).status).toBe('fieldwork');
  });
  it('reports missing actions only after the cutoff', () => {
    expect(computeDay(p, { IN: at(MON, '08:00') }, ctx(at(MON, '18:00'))).status).toBe('in_progress');
    const r = computeDay(p, { IN: at(MON, '08:00') }, ctx(end));
    expect(r.status).toBe('incomplete');
    expect(r.missingActions).toEqual(['OUT']);
  });
  it('computes split sessions separately', () => {
    const sp = plan(split);
    const r = computeDay(sp, { AM_IN: at(MON, '08:20'), AM_OUT: at(MON, '12:00'), PM_IN: at(MON, '13:00'), PM_OUT: at(MON, '16:30') }, ctx(end));
    expect(r.lateMinutes).toBe(20);
    expect(r.undertimeMinutes).toBe(30);
    expect(r.workedMinutes).toBe(220 + 210);
  });
  it('computes an overnight shift as one work date with break', () => {
    const np = plan(night);
    const r = computeDay(np, { IN: at(MON, '22:00'), OUT: at(MON, '06:00', 1) }, ctx(at(MON, '12:00', 1)));
    expect(r.status).toBe('completed');
    expect(r.workedMinutes).toBe(7 * 60);
    expect(r.workDate).toBe(MON);
  });
  it('lets flexible starts move the expected end', () => {
    const fp = plan(flex);
    const r = computeDay(fp, { IN: at(MON, '09:30'), OUT: at(MON, '18:30') }, ctx(end));
    expect(r.lateMinutes).toBe(0);
    expect(r.undertimeMinutes).toBe(0);
    const late = computeDay(fp, { IN: at(MON, '10:10'), OUT: at(MON, '19:00') }, ctx(end));
    expect(late.lateMinutes).toBe(10);
    expect(late.undertimeMinutes).toBe(0);
  });
  it('treats rest-day work as unscheduled potential overtime', () => {
    const rp = plan(baseSchedule, '2026-03-01');
    const r = computeDay(rp, { IN: at('2026-03-01', '09:00'), OUT: at('2026-03-01', '12:00') }, ctx(end));
    expect(r.exceptions).toEqual(expect.arrayContaining(['UNSCHEDULED_WORK', 'OVERTIME_CANDIDATE']));
    expect(r.overtimeCandidateMinutes).toBe(180);
  });
});

describe('effective punches', () => {
  it('overlays adjustments without losing originals', () => {
    const events = [{ action: 'IN' as const, at: 100 }, { action: 'IN' as const, at: 200 }];
    const { punches, corrected } = effectivePunches(events, [{ action: 'OUT', after: 900, createdAt: 1 }]);
    expect(punches).toEqual({ IN: 100, OUT: 900 });
    expect(corrected).toEqual(['OUT']);
    const v = effectivePunches(events, [{ action: 'IN', after: null, createdAt: 2 }]);
    expect(v.punches.IN).toBeUndefined();
  });
  it('marks corrected days in the computation', () => {
    const p: ShiftPlan = plan(baseSchedule);
    const r = computeDay(p, { IN: at(MON, '08:00'), OUT: at(MON, '17:00') }, { ...ctx(at(MON, '23:00')), correctedActions: ['OUT'] });
    expect(r.exceptions).toContain('CORRECTED');
  });
});
