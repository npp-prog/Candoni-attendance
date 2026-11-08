import type { HolidayDoc, ScheduleAssignmentDoc, ScheduleDoc, SessionInstance, ShiftPlan } from './types';
import { addDays, parseHHmm, weekdayOf, zonedToUtc } from './time';

export const SCHEDULE_DEFAULTS = {
  graceMinutes: 15,
  earlyInMinutes: 120,
  cutoffMinutes: 240,
  overtimeThresholdMinutes: 30,
  flexMinutes: 0,
};

/** Picks the assignment effective on a date: latest effectiveFrom wins. */
export function assignmentForDate(
  assignments: ScheduleAssignmentDoc[],
  date: string,
): ScheduleAssignmentDoc | null {
  let best: ScheduleAssignmentDoc | null = null;
  for (const a of assignments) {
    if (a.effectiveFrom > date) continue;
    if (a.effectiveTo && a.effectiveTo < date) continue;
    if (!best || a.effectiveFrom > best.effectiveFrom || (a.effectiveFrom === best.effectiveFrom && a.id > best.id)) {
      best = a;
    }
  }
  return best;
}

/**
 * Lays session templates onto a work date. Times are relative to the work
 * date's local midnight; each session must start at or after the previous one
 * ended and must end after it starts, so "22:00-06:00" becomes an overnight
 * session ending the next morning. The whole shift belongs to the work date.
 */
export function sessionOffsets(schedule: Pick<ScheduleDoc, 'sessions'>): { start: number; end: number }[] {
  const out: { start: number; end: number }[] = [];
  let floor = 0;
  for (const s of schedule.sessions) {
    let start = parseHHmm(s.start);
    while (start < floor) start += 1440;
    let end = parseHHmm(s.end);
    while (end <= start) end += 1440;
    out.push({ start, end });
    floor = end;
  }
  return out;
}

export function isOvernight(schedule: Pick<ScheduleDoc, 'sessions'>): boolean {
  const offs = sessionOffsets(schedule);
  return offs.length > 0 && offs[offs.length - 1].end > 1440;
}

export function validateSchedule(s: Partial<ScheduleDoc>): string | null {
  if (!s.name || !s.name.trim()) return 'Schedule name is required.';
  if (s.pattern !== 'single' && s.pattern !== 'split') return 'Pattern must be single or split.';
  const expected = s.pattern === 'single' ? 1 : 2;
  if (!Array.isArray(s.sessions) || s.sessions.length !== expected)
    return `A ${s.pattern} schedule needs exactly ${expected} session(s).`;
  try {
    const offs = sessionOffsets({ sessions: s.sessions });
    const total = offs[offs.length - 1].end - offs[0].start;
    if (total > 20 * 60) return 'A shift cannot span more than 20 hours.';
    if (s.breakStart || s.breakEnd) {
      if (s.pattern !== 'single') return 'Break windows apply to single-pattern schedules only.';
      if (!s.breakStart || !s.breakEnd) return 'Provide both break start and end.';
      parseHHmm(s.breakStart);
      parseHHmm(s.breakEnd);
    }
  } catch (e) {
    return (e as Error).message;
  }
  if (!Array.isArray(s.workDays) || s.workDays.some((d) => !Number.isInteger(d) || d < 0 || d > 6))
    return 'Work days must be weekday numbers 0-6.';
  for (const k of ['graceMinutes', 'flexMinutes', 'earlyInMinutes', 'cutoffMinutes', 'overtimeThresholdMinutes'] as const) {
    const v = s[k];
    if (typeof v !== 'number' || !Number.isInteger(v) || v < 0 || v > 720) return `${k} must be 0-720 minutes.`;
  }
  return null;
}

export interface PlanInputs {
  date: string;
  tz: string;
  schedule: ScheduleDoc | null;
  holiday: HolidayDoc | null;
}

/** Resolves the planned shift for a single work date. Pure and deterministic. */
export function buildShiftPlan({ date, tz, schedule, holiday }: PlanInputs): ShiftPlan {
  const dayStart = zonedToUtc(date, 0, tz);
  const nextDayStart = zonedToUtc(addDays(date, 1), 0, tz);
  const base: ShiftPlan = {
    workDate: date,
    kind: 'no_schedule',
    scheduleId: schedule?.id ?? null,
    scheduleName: schedule?.name ?? null,
    pattern: 'single',
    sessions: [],
    graceMinutes: 0,
    flexible: false,
    flexMinutes: 0,
    breakWindow: null,
    windowOpen: dayStart,
    windowClose: nextDayStart - 1,
    overtimeThresholdMinutes: schedule?.overtimeThresholdMinutes ?? SCHEDULE_DEFAULTS.overtimeThresholdMinutes,
    holidayName: holiday?.name ?? null,
    unscheduled: true,
  };
  if (!schedule || !schedule.active) return base;
  if (holiday) return { ...base, kind: 'holiday' };
  if (!schedule.workDays.includes(weekdayOf(date))) return { ...base, kind: 'rest_day' };

  const offs = sessionOffsets(schedule);
  const sessions: SessionInstance[] = offs.map((o) => ({
    start: zonedToUtc(date, o.start, tz),
    end: zonedToUtc(date, o.end, tz),
  }));
  let breakWindow: SessionInstance | null = null;
  if (schedule.pattern === 'single' && schedule.breakStart && schedule.breakEnd) {
    let bs = parseHHmm(schedule.breakStart);
    while (bs < offs[0].start) bs += 1440;
    let be = parseHHmm(schedule.breakEnd);
    while (be <= bs) be += 1440;
    breakWindow = { start: zonedToUtc(date, bs, tz), end: zonedToUtc(date, be, tz) };
  }
  return {
    ...base,
    kind: 'workday',
    pattern: schedule.pattern,
    sessions,
    graceMinutes: schedule.graceMinutes,
    flexible: schedule.flexible,
    flexMinutes: schedule.flexible ? schedule.flexMinutes : 0,
    breakWindow,
    windowOpen: sessions[0].start - schedule.earlyInMinutes * 60_000,
    windowClose: sessions[sessions.length - 1].end + schedule.cutoffMinutes * 60_000,
    unscheduled: false,
  };
}
