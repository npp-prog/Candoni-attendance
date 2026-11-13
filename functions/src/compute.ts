import { computeDay } from '../../shared/attendance';
import { daysBetweenInclusive, zonedToUtc, addDays } from '../../shared/time';
import type { DayComputation, MemberDoc } from '../../shared/types';
import { col } from './context';
import {
  fieldworkInRange,
  fieldworkOnPlan,
  leavesFor,
  loadScheduleContext,
  loadShifts,
  onLeave,
  planFor,
  shiftId,
  type ShiftDoc,
} from './data';

export interface DayRow extends DayComputation {
  memberId: string;
  employeeNumber: string;
  fullName: string;
  departmentId: string;
  scheduleName: string | null;
  holidayName: string | null;
  onLeave: boolean;
  hasFieldwork: boolean;
  hasWfh: boolean;
  /** Approved overtime: clocked overtime capped at the approved minutes (or the approved minutes when no overtime was clocked). */
  approvedOvertimeMinutes: number;
  /** Status of the day's overtime request, if any. */
  overtimeStatus: 'none' | 'pending' | 'approved' | 'rejected';
  unscheduled: boolean;
  workplaceNames: string[];
}

/**
 * Computes attendance for members over a date range from source records:
 * shift snapshots (punches = events overlaid with adjustments), schedules,
 * holidays, leave and fieldwork. Results are computed on demand so reports
 * never depend on stale cached summaries.
 */
export async function computeRange(orgId: string, tz: string, members: MemberDoc[], from: string, to: string, now: number): Promise<DayRow[]> {
  const dates = daysBetweenInclusive(from, to);
  if (dates.length > 62) throw new Error('Date range is limited to 62 days.');
  const single = members.length === 1 ? members[0].uid : undefined;
  const fromMs = zonedToUtc(from, 0, tz) - 86_400_000;
  const toMs = zonedToUtc(addDays(to, 1), 0, tz) + 86_400_000;
  const [sctx, shifts, leaves, fieldwork, otSnap, evSnap, otReqSnap] = await Promise.all([
    loadScheduleContext(orgId, tz, from, to, single ? [single] : undefined),
    loadShifts(orgId, from, to, single ? { memberId: single } : undefined),
    leavesFor(orgId, from, to, single),
    fieldworkInRange(orgId, fromMs, toMs, single),
    (single ? col(orgId, 'overtimeApprovals').where('memberId', '==', single) : col(orgId, 'overtimeApprovals'))
      .where('workDate', '>=', from)
      .where('workDate', '<=', to)
      .get(),
    (single ? col(orgId, 'attendanceEvents').where('memberId', '==', single) : col(orgId, 'attendanceEvents'))
      .where('workDate', '>=', from)
      .where('workDate', '<=', to)
      .select('memberId', 'workDate', 'workplaceName')
      .get(),
    (single ? col(orgId, 'correctionRequests').where('memberId', '==', single) : col(orgId, 'correctionRequests'))
      .where('workDate', '>=', from)
      .where('workDate', '<=', to)
      .select('memberId', 'workDate', 'type', 'status')
      .get(),
  ]);
  const otStatus = new Map<string, DayRow['overtimeStatus']>();
  const rank = { none: 0, rejected: 1, pending: 2, approved: 3 } as const;
  for (const d of otReqSnap.docs) {
    if (d.get('type') !== 'overtime') continue;
    const st = d.get('status') as string;
    if (!['pending', 'approved', 'rejected'].includes(st)) continue;
    const k = shiftId(d.get('memberId'), d.get('workDate'));
    const cur = otStatus.get(k) ?? 'none';
    if (rank[st as 'pending'] > rank[cur]) otStatus.set(k, st as DayRow['overtimeStatus']);
  }
  const ot = new Map<string, number>();
  for (const d of otSnap.docs) {
    const k = shiftId(d.get('memberId'), d.get('workDate'));
    ot.set(k, (ot.get(k) ?? 0) + (d.get('minutes') as number));
  }
  const places = new Map<string, Set<string>>();
  for (const d of evSnap.docs) {
    const k = shiftId(d.get('memberId'), d.get('workDate'));
    if (!places.has(k)) places.set(k, new Set());
    places.get(k)!.add(d.get('workplaceName'));
  }
  const rows: DayRow[] = [];
  for (const m of members) {
    for (const date of dates) {
      const key = shiftId(m.uid, date);
      const shift: ShiftDoc | undefined = shifts.get(key);
      const plan = shift?.plan ?? planFor(sctx, m.uid, date);
      const leave = onLeave(leaves, m.uid, date);
      const fw = fieldworkOnPlan(fieldwork, m.uid, plan, tz, 'fieldwork');
      const wfh = fieldworkOnPlan(fieldwork, m.uid, plan, tz, 'wfh');
      const c = computeDay(plan, shift?.punches ?? {}, {
        now,
        onLeave: leave,
        hasFieldwork: fw,
        hasWfh: wfh,
        correctedActions: shift?.correctedActions ?? [],
      });
      rows.push({
        ...c,
        memberId: m.uid,
        employeeNumber: m.employeeNumber,
        fullName: m.fullName,
        departmentId: shift?.departmentId ?? m.departmentId,
        scheduleName: plan.scheduleName,
        holidayName: plan.holidayName,
        onLeave: leave,
        hasFieldwork: fw,
        hasWfh: wfh,
        approvedOvertimeMinutes: approvedOvertime(otStatus.get(key) ?? 'none', ot.get(key) ?? 0, c.otWorkedMinutes),
        overtimeStatus: otStatus.get(key) ?? 'none',
        unscheduled: plan.unscheduled && Object.keys(shift?.punches ?? {}).length > 0,
        workplaceNames: [...(places.get(key) ?? [])],
      });
    }
  }
  return rows;
}

/** Approved overtime = clocked overtime capped at the approved minutes; without an overtime clock, the approved minutes. */
export function approvedOvertime(status: DayRow['overtimeStatus'], approvedCap: number, clocked: number): number {
  if (status !== 'approved') return 0;
  return clocked > 0 ? Math.min(clocked, approvedCap) : approvedCap;
}

export function summarize(rows: DayRow[]) {
  const expected = rows.filter((r) => r.kind === 'workday' && !r.onLeave);
  return {
    expected: expected.length,
    clockedIn: rows.filter((r) => Object.keys(r.punches).length > 0).length,
    late: rows.filter((r) => r.lateMinutes > 0).length,
    completed: rows.filter((r) => r.status === 'completed').length,
    inProgress: rows.filter((r) => r.status === 'in_progress').length,
    incomplete: rows.filter((r) => r.status === 'incomplete').length,
    fieldwork: rows.filter((r) => r.hasFieldwork).length,
    wfh: rows.filter((r) => r.hasWfh).length,
    absent: rows.filter((r) => r.status === 'absent').length,
    onLeave: rows.filter((r) => r.status === 'leave').length,
    awaiting: rows.filter((r) => r.status === 'awaiting' || r.status === 'upcoming').length,
  };
}
