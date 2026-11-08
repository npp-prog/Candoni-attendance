import type {
  AttendanceAction,
  DayComputation,
  DayStatus,
  ExceptionCode,
  SchedulePattern,
  ShiftPlan,
} from './types';

export type Punches = Partial<Record<AttendanceAction, number>>;

export function actionSequence(pattern: SchedulePattern): AttendanceAction[] {
  return pattern === 'split' ? ['AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT'] : ['IN', 'OUT'];
}

const MINUTE = 60_000;
const toMinute = (t: number) => Math.floor(t / MINUTE);

/**
 * The next valid action within a shift, or null if the sequence is complete.
 * Split pattern: if nothing was recorded and the AM session is already over
 * (past the midpoint of the lunch gap) the employee starts at PM In; the
 * missed AM actions become missing actions resolved through corrections.
 */
export function nextInSequence(plan: ShiftPlan, punches: Punches, now: number): AttendanceAction | null {
  const seq = actionSequence(plan.unscheduled ? 'single' : plan.pattern);
  let lastIdx = -1;
  seq.forEach((a, i) => {
    if (punches[a] != null) lastIdx = i;
  });
  if (lastIdx === -1 && plan.pattern === 'split' && !plan.unscheduled && plan.sessions.length === 2) {
    const mid = (plan.sessions[0].end + plan.sessions[1].start) / 2;
    return now >= mid ? 'PM_IN' : 'AM_IN';
  }
  return seq[lastIdx + 1] ?? null;
}

function hasPunches(p: Punches): boolean {
  return Object.values(p).some((v) => v != null);
}

function lastPunch(p: Punches): number | null {
  const vals = Object.values(p).filter((v): v is number => v != null);
  return vals.length ? Math.max(...vals) : null;
}

export type NextActionCode =
  | 'OK'
  | 'TOO_EARLY'
  | 'SHIFT_CLOSED'
  | 'SHIFT_COMPLETE'
  | 'NOT_SCHEDULED'
  | 'TOO_SOON';

export interface NextActionResult {
  code: NextActionCode;
  action: AttendanceAction | null;
  plan: ShiftPlan;
  workDate: string;
  message: string;
  availableAt?: number;
}

export interface NextActionInput {
  now: number;
  /** Plans for local yesterday, today and tomorrow (by work date). */
  plans: { yesterday: ShiftPlan; today: ShiftPlan; tomorrow: ShiftPlan };
  /** Effective punches keyed by work date. */
  punches: Record<string, Punches>;
  allowUnscheduled: boolean;
  unscheduledMaxHours: number;
  minActionIntervalSeconds: number;
}

function unscheduledOpen(plan: ShiftPlan, p: Punches, now: number, maxHours: number): boolean {
  return plan.unscheduled && p.IN != null && p.OUT == null && now <= p.IN + maxHours * 3_600_000;
}

/**
 * Chooses which shift (work date) an action at `now` belongs to and which
 * action is valid. Overnight shifts keep the work date on which they started,
 * so a 22:00–06:00 shift clocked out at 06:05 belongs to the previous day.
 */
export function determineNextAction(input: NextActionInput): NextActionResult {
  const { now, plans, allowUnscheduled, unscheduledMaxHours } = input;
  const ordered = [plans.yesterday, plans.today, plans.tomorrow];
  const punchesFor = (p: ShiftPlan) => input.punches[p.workDate] ?? {};

  const withInterval = (r: NextActionResult): NextActionResult => {
    if (r.code !== 'OK') return r;
    const last = lastPunch(punchesFor(r.plan));
    const until = last != null ? last + input.minActionIntervalSeconds * 1000 : 0;
    if (last != null && now < until) {
      return {
        ...r,
        code: 'TOO_SOON',
        availableAt: until,
        message: 'Your previous action was just recorded. Please wait a moment before the next one.',
      };
    }
    return r;
  };
  const ok = (plan: ShiftPlan, action: AttendanceAction): NextActionResult =>
    withInterval({ code: 'OK', action, plan, workDate: plan.workDate, message: 'Ready.' });

  // (a) A started, unfinished shift that is still open always takes priority.
  for (const plan of ordered) {
    const p = punchesFor(plan);
    if (!hasPunches(p)) continue;
    if (plan.unscheduled) {
      if (unscheduledOpen(plan, p, now, unscheduledMaxHours)) return ok(plan, 'OUT');
      continue;
    }
    if (now >= plan.windowOpen && now <= plan.windowClose) {
      const next = nextInSequence(plan, p, now);
      if (next) return ok(plan, next);
    }
  }

  // (b) A scheduled shift whose window is open and has no punches yet.
  const y = plans.yesterday;
  if (y.kind === 'workday' && !hasPunches(punchesFor(y)) && now >= y.windowOpen && now < y.sessions[y.sessions.length - 1].end) {
    return ok(y, nextInSequence(y, {}, now)!);
  }
  const t = plans.today;
  const tp = punchesFor(t);
  if (t.kind === 'workday') {
    if (now >= t.windowOpen && now <= t.windowClose) {
      const next = nextInSequence(t, tp, now);
      if (next) return ok(t, next);
      return { code: 'SHIFT_COMPLETE', action: null, plan: t, workDate: t.workDate, message: 'All attendance actions for today are recorded.' };
    }
  }
  const tm = plans.tomorrow;
  if (tm.kind === 'workday' && !hasPunches(punchesFor(tm)) && now >= tm.windowOpen && now <= tm.windowClose) {
    return ok(tm, nextInSequence(tm, {}, now)!);
  }

  // (c) Explain why nothing is available today.
  if (t.kind === 'workday') {
    if (now < t.windowOpen) {
      return {
        code: 'TOO_EARLY',
        action: null,
        plan: t,
        workDate: t.workDate,
        availableAt: t.windowOpen,
        message: 'Clock-in is not open yet for today’s shift.',
      };
    }
    return {
      code: 'SHIFT_CLOSED',
      action: null,
      plan: t,
      workDate: t.workDate,
      message: hasPunches(tp)
        ? 'Today’s attendance window has closed. Submit a correction request for any missing entry.'
        : 'Today’s attendance window has closed. Submit a correction request if you worked today.',
    };
  }
  // Rest day, holiday or no schedule.
  if (!allowUnscheduled) {
    return {
      code: 'NOT_SCHEDULED',
      action: null,
      plan: t,
      workDate: t.workDate,
      message:
        t.kind === 'holiday'
          ? `Today is a holiday (${t.holidayName}). Attendance is not expected.`
          : t.kind === 'rest_day'
            ? 'Today is your rest day. Attendance is not expected.'
            : 'You have no schedule assigned for today. Please contact HR.',
    };
  }
  const unscheduledToday: ShiftPlan = { ...t, unscheduled: true, pattern: 'single' };
  if (tp.IN == null) return ok(unscheduledToday, 'IN');
  if (tp.OUT == null) {
    return {
      code: 'SHIFT_CLOSED',
      action: null,
      plan: unscheduledToday,
      workDate: t.workDate,
      message: `Clock-out is only accepted within ${unscheduledMaxHours} hours of clock-in. Submit a correction request.`,
    };
  }
  return { code: 'SHIFT_COMPLETE', action: null, plan: unscheduledToday, workDate: t.workDate, message: 'All attendance actions for today are recorded.' };
}

export interface DayContext {
  now: number;
  onLeave: boolean;
  hasFieldwork: boolean;
  correctedActions?: AttendanceAction[];
  unscheduledMaxHours?: number;
}

/**
 * Deterministic daily computation. Punch times are truncated to the minute.
 * - Late: arrival minute after (scheduled start + flex) beyond the grace period;
 *   once beyond grace, lateness is counted from the (flex-adjusted) start.
 * - Undertime: departure before the (flex-adjusted) scheduled end of a session.
 *   A session with no punches at all is reported as missing actions, not undertime.
 * - Worked: sum of completed in/out pairs, minus overlap with the unpaid break window.
 * - Potential overtime: time after the scheduled end once it exceeds the threshold,
 *   or all worked time on an unscheduled day. It is never auto-approved.
 * - Missing actions and absence are only reported after the shift cutoff.
 */
export function computeDay(plan: ShiftPlan, punchesRaw: Punches, ctx: DayContext): DayComputation {
  const punches: Punches = {};
  for (const [k, v] of Object.entries(punchesRaw)) if (v != null) punches[k as AttendanceAction] = v;
  const exceptions = new Set<ExceptionCode>();
  const corrected = ctx.correctedActions ?? [];
  if (corrected.length) exceptions.add('CORRECTED');
  const result = (status: DayStatus, extra: Partial<DayComputation> = {}): DayComputation => ({
    workDate: plan.workDate,
    status,
    kind: plan.kind,
    punches,
    correctedActions: corrected,
    lateMinutes: 0,
    undertimeMinutes: 0,
    workedMinutes: 0,
    overtimeCandidateMinutes: 0,
    missingActions: [],
    exceptions: [...exceptions],
    ...extra,
  });

  const any = hasPunches(punches);
  const isWorkday = plan.kind === 'workday';

  if (!any) {
    if (!isWorkday) return result(plan.kind === 'holiday' ? 'holiday' : plan.kind === 'rest_day' ? 'rest_day' : 'no_schedule');
    if (ctx.onLeave) return result('leave');
    if (now(ctx) < plan.sessions[0].start) return result('upcoming');
    if (now(ctx) <= plan.windowClose) return result(ctx.hasFieldwork ? 'fieldwork' : 'awaiting');
    if (ctx.hasFieldwork) {
      exceptions.add('FIELDWORK_NO_PUNCH');
      return result('fieldwork');
    }
    exceptions.add('ABSENT');
    return result('absent', { missingActions: actionSequence(plan.pattern) });
  }

  // Unscheduled work (rest day, holiday, no schedule): single in/out pair.
  if (!isWorkday || plan.unscheduled) {
    exceptions.add('UNSCHEDULED_WORK');
    const maxH = ctx.unscheduledMaxHours ?? 16;
    let worked = 0;
    if (punches.IN != null && punches.OUT != null) worked = Math.max(0, toMinute(punches.OUT) - toMinute(punches.IN));
    if (worked > 0) exceptions.add('OVERTIME_CANDIDATE');
    const closed = punches.IN != null ? now(ctx) > punches.IN + maxH * 3_600_000 : true;
    const missing: AttendanceAction[] = [];
    if (punches.IN == null) missing.push('IN');
    if (punches.OUT == null) missing.push('OUT');
    if (missing.length && closed) exceptions.add('MISSING_ACTION');
    const status: DayStatus = missing.length === 0 ? 'completed' : closed ? 'incomplete' : 'in_progress';
    return result(status, {
      workedMinutes: worked,
      overtimeCandidateMinutes: worked,
      missingActions: closed ? missing : [],
      exceptions: [...exceptions],
    });
  }

  const seq = actionSequence(plan.pattern);
  const pairs: [AttendanceAction, AttendanceAction][] = [];
  for (let i = 0; i < seq.length; i += 2) pairs.push([seq[i], seq[i + 1]]);

  let late = 0;
  let undertime = 0;
  let worked = 0;
  let overtime = 0;
  let flexShift = 0; // minutes the (flexible) start floated, which also moves the expected end

  pairs.forEach(([inA, outA], idx) => {
    const session = plan.sessions[idx];
    const tIn = punches[inA];
    const tOut = punches[outA];
    const sStart = toMinute(session.start);
    const sEnd = toMinute(session.end);
    if (tIn != null) {
      const inMin = toMinute(tIn);
      let allowedStart = sStart;
      if (idx === 0 && plan.flexible && plan.flexMinutes > 0) {
        flexShift = Math.min(Math.max(inMin - sStart, 0), plan.flexMinutes);
        allowedStart = sStart + flexShift;
      }
      const lateBy = inMin - allowedStart;
      if (lateBy > plan.graceMinutes) late += lateBy;
    }
    if (tOut != null) {
      const outMin = toMinute(tOut);
      const expectedEnd = sEnd + (plan.flexible ? flexShift : 0);
      if (tIn != null && outMin < expectedEnd) undertime += expectedEnd - Math.max(outMin, toMinute(tIn));
      if (idx === pairs.length - 1 && outMin - expectedEnd >= plan.overtimeThresholdMinutes) {
        overtime += outMin - expectedEnd;
      }
    }
    if (tIn != null && tOut != null) {
      const a = toMinute(tIn);
      const b = toMinute(tOut);
      let w = Math.max(0, b - a);
      if (plan.breakWindow && idx === 0) {
        const bs = toMinute(plan.breakWindow.start);
        const be = toMinute(plan.breakWindow.end);
        w -= Math.max(0, Math.min(b, be) - Math.max(a, bs));
      }
      worked += Math.max(0, w);
    }
  });

  const closed = now(ctx) > plan.windowClose;
  const missingAll = seq.filter((a) => punches[a] == null);
  const missing = closed ? missingAll : [];
  if (late > 0) exceptions.add('LATE');
  if (undertime > 0) exceptions.add('UNDERTIME');
  if (overtime > 0) exceptions.add('OVERTIME_CANDIDATE');
  if (missing.length) exceptions.add('MISSING_ACTION');

  let status: DayStatus;
  if (missingAll.length === 0) status = 'completed';
  else if (!closed) status = 'in_progress';
  else status = 'incomplete';

  return result(status, {
    lateMinutes: late,
    undertimeMinutes: undertime,
    workedMinutes: worked,
    overtimeCandidateMinutes: overtime,
    missingActions: missing,
    exceptions: [...exceptions],
  });
}

function now(ctx: DayContext) {
  return ctx.now;
}

export interface PunchRecord {
  action: AttendanceAction;
  at: number;
}
export interface AdjustmentRecord {
  action: AttendanceAction;
  /** New time, or null to void the action. */
  after: number | null;
  createdAt: number;
}

/**
 * Effective punches = original accepted events overlaid with approved
 * adjustments (latest adjustment per action wins). Originals are never mutated.
 */
export function effectivePunches(events: PunchRecord[], adjustments: AdjustmentRecord[]): { punches: Punches; corrected: AttendanceAction[] } {
  const punches: Punches = {};
  for (const e of [...events].sort((a, b) => a.at - b.at)) if (punches[e.action] == null) punches[e.action] = e.at;
  const corrected = new Set<AttendanceAction>();
  for (const adj of [...adjustments].sort((a, b) => a.createdAt - b.createdAt)) {
    corrected.add(adj.action);
    if (adj.after == null) delete punches[adj.action];
    else punches[adj.action] = adj.after;
  }
  return { punches, corrected: [...corrected] };
}
