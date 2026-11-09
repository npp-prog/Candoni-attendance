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
  const input = z.object({ date: dateStr.nullish(), departmentId: z.string().max(128).nullish() }).parse(raw ?? {});
  const tz = caller.org.settings.timezone;
  const date = input.date ?? localDate(now, tz);
  const members = await scopedMembers(caller, { departmentId: input.departmentId ?? undefined });
  const rows = members.length ? await computeRange(caller.orgId, tz, members, date, date, now) : [];
  return { date, timezone: tz, serverTime: now, summary: summarize(rows), rows };
}

const reportSchema = z.object({
  type: z.enum(['daily', 'dtr', 'department_summary', 'late_undertime', 'missing_absence', 'corrections', 'fieldwork', 'device_anomalies']),
  from: dateStr,
  to: dateStr,
  departmentId: z.string().max(128).nullish(),
  memberId: z.string().max(128).nullish(),
  status: z.string().max(40).nullish(),
});

export async function runReport(caller: Caller, raw: unknown, now = Date.now()) {
  const input = reportSchema.parse(raw);
  if (input.to < input.from) throw new HttpsError('invalid-argument', 'The end date is before the start date.');
  if (addDays(input.from, 62) <= input.to) throw new HttpsError('invalid-argument', 'Reports are limited to 62 days. Narrow the range.');
  const tz = caller.org.settings.timezone;
  if (input.type === 'dtr' && !input.memberId) throw new HttpsError('invalid-argument', 'Choose an employee for the monthly time record.');
  const members = await scopedMembers(caller, { departmentId: input.departmentId ?? undefined, memberId: input.memberId ?? undefined, includeInactive: !!input.memberId });
  const base = { type: input.type, from: input.from, to: input.to, timezone: tz, generatedAt: now, generatedBy: caller.member.fullName };

  if (input.type === 'device_anomalies') {
    if (!isAttendanceAdmin(caller.member.role)) throw new HttpsError('permission-denied', 'The suspicious-activity report is available to HR and system administrators.');
    const fromMs = zonedToUtc(input.from, 0, tz);
    const toMs = zonedToUtc(addDays(input.to, 1), 0, tz);
    return { ...base, rows: await deviceAnomalies(caller.orgId, members, fromMs, toMs) };
  }
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
      .filter((e) => allowed.has(e.memberId) && /^(fieldwork|wfh)_/.test(String(e.validation)))
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
    return { ...base, rows: rows.filter((r) => r.status === 'absent' || r.status === 'incomplete' || r.exceptions.includes('FIELDWORK_NO_PUNCH') || r.exceptions.includes('WFH_NO_PUNCH')), departments: deptNames };
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
    wfhDays: list.filter((r) => r.hasWfh).length,
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

const RAPID_WINDOW_MS = 15 * 60_000;

/**
 * Signals that one phone may be used for several employees. The device hint is
 * a random per-browser value: it can be cleared, so absence of a finding is not
 * proof, and a finding is a prompt to check, not proof of wrongdoing.
 */
async function deviceAnomalies(orgId: string, members: MemberDoc[], fromMs: number, toMs: number) {
  const names = new Map(members.map((m) => [m.uid, m.fullName]));
  const [evidence, attempts, pending, phones] = await Promise.all([
    col(orgId, 'attendanceLocationEvidence').where('receivedAt', '>=', fromMs).where('receivedAt', '<', toMs).select('memberId', 'deviceHint', 'receivedAt', 'workDate', 'deviceVerified').get(),
    col(orgId, 'attendanceAttempts').where('at', '>=', fromMs).where('at', '<', toMs).select('memberId', 'code', 'deviceHint', 'at').get(),
    col(orgId, 'devices').where('status', '==', 'pending').get(),
    col(orgId, 'devices').get(),
  ]);
  const rows: Row[] = [];
  // Phones each employee has registered, by browser hint and registration time.
  const registered = new Map<string, { hints: Set<string>; since: number }>();
  for (const d of phones.docs) {
    if (!['active', 'replaced'].includes(d.get('status'))) continue;
    const r = registered.get(d.get('memberId')) ?? { hints: new Set<string>(), since: Infinity };
    if (d.get('deviceHint')) r.hints.add(d.get('deviceHint'));
    r.since = Math.min(r.since, d.get('approvedAt') ?? d.get('createdAt'));
    registered.set(d.get('memberId'), r);
  }
  // One employee, several phones: clock actions after registration from another
  // phone without confirmation, and actions in one shift from different phones.
  const unregistered = new Map<string, number[]>();
  const perShift = new Map<string, { memberId: string; workDate: string; hints: Set<string>; times: number[] }>();
  for (const d of evidence.docs) {
    const memberId = d.get('memberId') as string;
    const hint = d.get('deviceHint') as string | null;
    const at = d.get('receivedAt') as number;
    if (!names.has(memberId) || !hint) continue;
    const reg = registered.get(memberId);
    if (reg && at >= reg.since && d.get('deviceVerified') !== true && !reg.hints.has(hint)) {
      if (!unregistered.has(memberId)) unregistered.set(memberId, []);
      unregistered.get(memberId)!.push(at);
    }
    const key = `${memberId}_${d.get('workDate')}`;
    const s = perShift.get(key) ?? { memberId, workDate: d.get('workDate'), hints: new Set<string>(), times: [] as number[] };
    s.hints.add(hint);
    s.times.push(at);
    perShift.set(key, s);
  }
  for (const [memberId, times] of unregistered) {
    times.sort((a, b) => a - b);
    rows.push({ kind: 'unregistered_phone', severity: 'high', description: `${times.length} clock action(s) from a phone other than the employee’s registered phone, without phone confirmation.`, employees: [names.get(memberId)], device: null, count: times.length, firstAt: times[0], lastAt: times[times.length - 1] });
  }
  for (const s of perShift.values()) {
    if (s.hints.size < 2) continue;
    s.times.sort((a, b) => a - b);
    rows.push({ kind: 'different_phones_same_shift', severity: 'medium', description: `Clock actions on ${s.workDate} were made from ${s.hints.size} different phones.`, employees: [names.get(s.memberId)], device: null, count: s.times.length, firstAt: s.times[0], lastAt: s.times[s.times.length - 1] });
  }
  const byHint = new Map<string, { memberId: string; at: number }[]>();
  for (const d of evidence.docs) {
    const hint = d.get('deviceHint') as string | null;
    if (!hint || !names.has(d.get('memberId'))) continue;
    if (!byHint.has(hint)) byHint.set(hint, []);
    byHint.get(hint)!.push({ memberId: d.get('memberId'), at: d.get('receivedAt') });
  }
  for (const [hint, list] of byHint) {
    const ids = [...new Set(list.map((x) => x.memberId))];
    if (ids.length < 2) continue;
    list.sort((a, b) => a.at - b.at);
    rows.push({
      kind: 'shared_phone', severity: 'high',
      description: `One phone was used to record attendance for ${ids.length} employees.`,
      employees: ids.map((i) => names.get(i)), device: hint.slice(0, 8), count: list.length, firstAt: list[0].at, lastAt: list[list.length - 1].at,
    });
    for (let i = 1; i < list.length; i++) {
      if (list[i].memberId !== list[i - 1].memberId && list[i].at - list[i - 1].at <= RAPID_WINDOW_MS) {
        rows.push({
          kind: 'rapid_multi_account', severity: 'high',
          description: `Different employees clocked on the same phone ${Math.round((list[i].at - list[i - 1].at) / 60_000)} min apart.`,
          employees: [names.get(list[i - 1].memberId), names.get(list[i].memberId)], device: hint.slice(0, 8), count: 2, firstAt: list[i - 1].at, lastAt: list[i].at,
        });
      }
    }
  }
  const failures = new Map<string, number[]>();
  for (const d of attempts.docs) {
    if (!String(d.get('code')).startsWith('DEVICE_') || !names.has(d.get('memberId'))) continue;
    if (!failures.has(d.get('memberId'))) failures.set(d.get('memberId'), []);
    failures.get(d.get('memberId'))!.push(d.get('at'));
  }
  for (const [memberId, times] of failures) {
    if (times.length < 3) continue;
    times.sort((a, b) => a - b);
    rows.push({ kind: 'repeated_device_failures', severity: 'medium', description: `${times.length} clock-in attempts failed the registered-phone check.`, employees: [names.get(memberId)], device: null, count: times.length, firstAt: times[0], lastAt: times[times.length - 1] });
  }
  for (const d of pending.docs) {
    if (!names.has(d.get('memberId'))) continue;
    rows.push({ kind: 'pending_phone', severity: 'info', description: `Phone registration awaiting approval (${d.get('label')}).`, employees: [d.get('memberName')], device: null, count: 1, firstAt: d.get('createdAt'), lastAt: d.get('createdAt') });
  }
  const order: Record<string, number> = { high: 0, medium: 1, info: 2 };
  return rows.sort((a, b) => order[a.severity] - order[b.severity] || b.lastAt - a.lastAt);
}
