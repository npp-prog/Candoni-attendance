import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { canViewDepartment, isAttendanceAdmin } from '../../shared/roles';
import { addDays, isValidDate, localDate, monthRange, zonedToUtc } from '../../shared/time';
import type { MemberDoc } from '../../shared/types';
import { col, requireRole, type Caller } from './context';
import { computeRange, summarize, type DayRow } from './compute';
import { loadMembers } from './data';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Row = Record<string, any>;
const withId = (d: FirebaseFirestore.QueryDocumentSnapshot): Row => ({ id: d.id, ...d.data() });

const dateStr = z.string().refine(isValidDate, 'Invalid date');

/** Members visible to the caller: all for HR/sysadmin, supervised departments for supervisors. */
async function scopedMembers(caller: Caller, filter: { departmentId?: string; memberId?: string; includeInactive?: boolean }) {
  requireRole(caller, ['supervisor', 'hr', 'sysadmin'], 'view attendance reports');
  if (filter.departmentId && !canViewDepartment(caller.member, filter.departmentId)) throw new HttpsError('permission-denied', 'That department is outside your scope.');
  let members = await loadMembers(caller.orgId);
  members = members.filter((m) => canViewDepartment(caller.member, m.departmentId));
  if (filter.departmentId) members = members.filter((m) => m.departmentId === filter.departmentId);
  if (filter.memberId) {
    members = members.filter((m) => m.uid === filter.memberId);
    if (!members.length) throw new HttpsError('permission-denied', 'That employee is outside your scope.');
  }
  if (!filter.includeInactive && !filter.memberId) members = members.filter((m) => m.active);
  return members.sort((a, b) => a.fullName.localeCompare(b.fullName));
}

export async function dailyMonitor(caller: Caller, raw: unknown, now = Date.now()) {
  const input = z.object({ date: dateStr.optional(), departmentId: z.string().optional() }).parse(raw ?? {});
  const tz = caller.org.settings.timezone;
  const date = input.date ?? localDate(now, tz);
  const members = await scopedMembers(caller, { departmentId: input.departmentId });
  const rows = members.length ? await computeRange(caller.orgId, tz, members, date, date, now) : [];
  return { date, timezone: tz, serverTime: now, summary: summarize(rows), rows };
}

const reportSchema = z.object({
  type: z.enum(['daily', 'dtr', 'department_summary', 'late_undertime', 'missing_absence', 'corrections', 'fieldwork']),
  from: dateStr,
  to: dateStr,
  departmentId: z.string().max(128).optional(),
  memberId: z.string().max(128).optional(),
  status: z.string().max(40).optional(),
});

export async function runReport(caller: Caller, raw: unknown, now = Date.now()) {
  const input = reportSchema.parse(raw);
  if (input.to < input.from) throw new HttpsError('invalid-argument', 'The end date is before the start date.');
  if (addDays(input.from, 62) <= input.to) throw new HttpsError('invalid-argument', 'Reports are limited to 62 days. Narrow the range.');
  const tz = caller.org.settings.timezone;
  if (input.type === 'dtr' && !input.memberId) throw new HttpsError('invalid-argument', 'Choose an employee for the monthly time record.');
  const members = await scopedMembers(caller, { departmentId: input.departmentId, memberId: input.memberId, includeInactive: !!input.memberId });
  const base = { type: input.type, from: input.from, to: input.to, timezone: tz, generatedAt: now, generatedBy: caller.member.fullName };

  if (input.type === 'corrections') {
    const snap = await col(caller.orgId, 'adjustments').where('workDate', '>=', input.from).where('workDate', '<=', input.to).get();
    const allowed = new Set(members.map((m) => m.uid));
    const rows = snap.docs
      .map(withId)
      .filter((r) => allowed.has(r.memberId))
      .sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0));
    return { ...base, rows };
  }
  if (input.type === 'fieldwork') {
    const fromMs = zonedToUtc(input.from, 0, tz);
    const toMs = zonedToUtc(addDays(input.to, 1), 0, tz);
    const snap = await col(caller.orgId, 'fieldworkAuthorizations').where('endAt', '>=', fromMs).get();
    const allowed = new Set(members.map((m) => m.uid));
    const auths = snap.docs.map(withId).filter((r) => allowed.has(r.memberId) && r.startAt < toMs);
    const evSnap = await col(caller.orgId, 'attendanceEvents').where('workDate', '>=', input.from).where('workDate', '<=', input.to).get();
    const events = evSnap.docs
      .map((d) => d.data())
      .filter((e) => allowed.has(e.memberId) && String(e.validation).startsWith('fieldwork'))
      .map((e) => ({ memberId: e.memberId, memberName: e.memberName, workDate: e.workDate, action: e.action, at: e.at, validation: e.validation, workplaceName: e.workplaceName }));
    // Exact coordinates of alternate locations are only returned to HR/sysadmin.
    const showCoords = isAttendanceAdmin(caller.member.role);
    return { ...base, rows: auths.map((a) => (showCoords ? a : { ...a, lat: null, lng: null })), events };
  }

  const rows = members.length ? await computeRange(caller.orgId, tz, members, input.from, input.to, now) : [];
  const deptNames = await departmentNames(caller.orgId);
  if (input.type === 'daily' || input.type === 'dtr') {
    const filtered = input.status ? rows.filter((r) => r.status === input.status) : rows;
    return { ...base, rows: filtered, departments: deptNames, member: input.memberId ? memberInfo(members[0], deptNames) : null };
  }
  if (input.type === 'missing_absence') {
    return { ...base, rows: rows.filter((r) => r.status === 'absent' || r.status === 'incomplete' || r.exceptions.includes('FIELDWORK_NO_PUNCH')), departments: deptNames };
  }
  if (input.type === 'late_undertime') {
    const per = aggregate(rows, (r) => r.memberId);
    return {
      ...base,
      departments: deptNames,
      rows: per
        .filter((a) => a.lateCount || a.undertimeMinutes)
        .map((a) => ({ ...a, fullName: a.sample.fullName, employeeNumber: a.sample.employeeNumber, departmentId: a.sample.departmentId })),
      details: rows.filter((r) => r.lateMinutes || r.undertimeMinutes),
    };
  }
  // department_summary
  const per = aggregate(rows, (r) => r.departmentId);
  return { ...base, departments: deptNames, rows: per.map((a) => ({ ...a, departmentId: a.key, departmentName: deptNames[a.key] ?? a.key })) };
}

function aggregate(rows: DayRow[], keyFn: (r: DayRow) => string) {
  const map = new Map<string, DayRow[]>();
  for (const r of rows) {
    const k = keyFn(r);
    if (!map.has(k)) map.set(k, []);
    map.get(k)!.push(r);
  }
  return [...map.entries()].map(([key, list]) => {
    const { sample, ...rest } = { sample: list[0], ...counts(list) };
    return { key, sample: { fullName: sample.fullName, employeeNumber: sample.employeeNumber, departmentId: sample.departmentId }, ...rest };
  });
}

function counts(list: DayRow[]) {
  const sum = (f: (r: DayRow) => number) => list.reduce((a, r) => a + f(r), 0);
  return {
    expectedDays: list.filter((r) => r.kind === 'workday' && !r.onLeave).length,
    presentDays: list.filter((r) => Object.keys(r.punches).length > 0).length,
    completedDays: list.filter((r) => r.status === 'completed').length,
    incompleteDays: list.filter((r) => r.status === 'incomplete').length,
    absentDays: list.filter((r) => r.status === 'absent').length,
    leaveDays: list.filter((r) => r.status === 'leave').length,
    fieldworkDays: list.filter((r) => r.hasFieldwork).length,
    lateCount: list.filter((r) => r.lateMinutes > 0).length,
    lateMinutes: sum((r) => r.lateMinutes),
    undertimeMinutes: sum((r) => r.undertimeMinutes),
    workedMinutes: sum((r) => r.workedMinutes),
    overtimeCandidateMinutes: sum((r) => r.overtimeCandidateMinutes),
    approvedOvertimeMinutes: sum((r) => r.approvedOvertimeMinutes),
    correctedDays: list.filter((r) => r.correctedActions.length > 0).length,
  };
}

async function departmentNames(orgId: string) {
  const snap = await col(orgId, 'departments').get();
  return Object.fromEntries(snap.docs.map((d) => [d.id, d.get('name') as string]));
}

function memberInfo(m: MemberDoc | undefined, depts: Record<string, string>) {
  if (!m) return null;
  return { uid: m.uid, fullName: m.fullName, employeeNumber: m.employeeNumber, position: m.position, department: depts[m.departmentId] ?? m.departmentId, classification: m.classification };
}

/** Employee's own monthly history (always scoped to the caller). */
export async function myHistory(caller: Caller, raw: unknown, now = Date.now()) {
  const { month } = z.object({ month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/) }).parse(raw);
  const tz = caller.org.settings.timezone;
  const { from, to } = monthRange(month);
  const today = localDate(now, tz);
  const end = to < today ? to : today;
  if (from > end) return { month, timezone: tz, rows: [] };
  const rows = await computeRange(caller.orgId, tz, [caller.member], from, end, now);
  return { month, timezone: tz, rows: rows.reverse() };
}

/**
 * Details for one employee-day: original events, adjustments and requests.
 * Precise coordinates are included only for the employee themself and HR/sysadmin.
 */
export async function dayDetail(caller: Caller, raw: unknown) {
  const input = z.object({ memberId: z.string().min(1).max(128), workDate: dateStr }).parse(raw);
  const isSelf = input.memberId === caller.uid;
  if (!isSelf) {
    const target = await col(caller.orgId, 'members').doc(input.memberId).get();
    if (!target.exists || !canViewDepartment(caller.member, target.get('departmentId'))) throw new HttpsError('permission-denied', 'That employee is outside your scope.');
  }
  const [events, adjustments, requests] = await Promise.all([
    col(caller.orgId, 'attendanceEvents').where('memberId', '==', input.memberId).where('workDate', '==', input.workDate).get(),
    col(caller.orgId, 'adjustments').where('memberId', '==', input.memberId).where('workDate', '==', input.workDate).get(),
    col(caller.orgId, 'correctionRequests').where('memberId', '==', input.memberId).where('workDate', '==', input.workDate).get(),
  ]);
  const showCoords = isSelf || isAttendanceAdmin(caller.member.role);
  const evidence = showCoords
    ? await Promise.all(events.docs.map((d) => col(caller.orgId, 'attendanceLocationEvidence').doc(d.id).get()))
    : [];
  return {
    events: events.docs
      .map((d, i): Row => ({
        ...withId(d),
        evidence: showCoords && evidence[i]?.exists ? { lat: evidence[i].get('lat'), lng: evidence[i].get('lng'), accuracyMeters: evidence[i].get('accuracyMeters'), capturedAt: evidence[i].get('capturedAt') } : null,
      }))
      .sort((a, b) => a.at - b.at),
    adjustments: adjustments.docs.map(withId).sort((a, b) => a.createdAt - b.createdAt),
    requests: requests.docs.map(withId),
  };
}
