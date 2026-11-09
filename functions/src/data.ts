import type { Transaction } from 'firebase-admin/firestore';
import { effectivePunches, type Punches } from '../../shared/attendance';
import type { GeofenceTarget } from '../../shared/geo';
import { assignmentForDate, buildShiftPlan } from '../../shared/schedule';
import { addDays, localDate } from '../../shared/time';
import type {
  AttendanceAction,
  FieldworkDetails,
  HolidayDoc,
  LeaveDoc,
  MemberDoc,
  ScheduleAssignmentDoc,
  ScheduleDoc,
  ShiftPlan,
  WorkplaceDoc,
} from '../../shared/types';
import { col, db } from './context';

export const shiftId = (memberId: string, workDate: string) => `${memberId}_${workDate}`;

export interface ShiftDoc {
  orgId: string;
  memberId: string;
  departmentId: string;
  workDate: string;
  plan: ShiftPlan;
  punches: Punches;
  correctedActions: AttendanceAction[];
  eventIds: Partial<Record<AttendanceAction, string>>;
  version: number;
  updatedAt: number;
}

export interface ScheduleContext {
  tz: string;
  schedules: Map<string, ScheduleDoc>;
  holidays: Map<string, HolidayDoc>;
  assignmentsByMember: Map<string, ScheduleAssignmentDoc[]>;
}

/** Loads schedules, holidays (in range) and assignments for the given members. */
export async function loadScheduleContext(orgId: string, tz: string, from: string, to: string, memberIds?: string[]): Promise<ScheduleContext> {
  const assignmentsQuery =
    memberIds && memberIds.length === 1
      ? col(orgId, 'scheduleAssignments').where('memberId', '==', memberIds[0]).get()
      : col(orgId, 'scheduleAssignments').get();
  const [schedSnap, holSnap, asSnap] = await Promise.all([
    col(orgId, 'schedules').get(),
    col(orgId, 'holidays').where('date', '>=', from).where('date', '<=', to).get(),
    assignmentsQuery,
  ]);
  const schedules = new Map(schedSnap.docs.map((d) => [d.id, { ...(d.data() as ScheduleDoc), id: d.id }]));
  const holidays = new Map(holSnap.docs.map((d) => [d.get('date') as string, { ...(d.data() as HolidayDoc), id: d.id }]));
  const assignmentsByMember = new Map<string, ScheduleAssignmentDoc[]>();
  for (const d of asSnap.docs) {
    const a = { ...(d.data() as ScheduleAssignmentDoc), id: d.id };
    const list = assignmentsByMember.get(a.memberId) ?? [];
    list.push(a);
    assignmentsByMember.set(a.memberId, list);
  }
  return { tz, schedules, holidays, assignmentsByMember };
}

export function planFor(ctx: ScheduleContext, memberId: string, date: string): ShiftPlan {
  const assignment = assignmentForDate(ctx.assignmentsByMember.get(memberId) ?? [], date);
  const schedule = assignment ? ctx.schedules.get(assignment.scheduleId) ?? null : null;
  return buildShiftPlan({ date, tz: ctx.tz, schedule, holiday: ctx.holidays.get(date) ?? null });
}

export function currentScheduleName(ctx: ScheduleContext, memberId: string, date: string): string | null {
  const a = assignmentForDate(ctx.assignmentsByMember.get(memberId) ?? [], date);
  return a ? ctx.schedules.get(a.scheduleId)?.name ?? null : null;
}

/** Workplaces the member may clock in at: individually assigned or via department. */
export async function authorizedWorkplaces(orgId: string, member: MemberDoc): Promise<WorkplaceDoc[]> {
  const snap = await col(orgId, 'workplaces').where('active', '==', true).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as WorkplaceDoc), id: d.id }))
    .filter(
      (w) =>
        (member.workplaceIds ?? []).includes(w.id) ||
        (w.departmentIds ?? []).includes(member.departmentId) ||
        (w.memberIds ?? []).includes(member.uid),
    );
}

export interface FieldworkAuth extends FieldworkDetails {
  id: string;
  memberId: string;
  departmentId: string;
  active: boolean;
  requestId: string;
}

export async function activeFieldwork(orgId: string, memberId: string, at: number): Promise<FieldworkAuth[]> {
  const snap = await col(orgId, 'fieldworkAuthorizations').where('memberId', '==', memberId).where('endAt', '>=', at).get();
  return snap.docs
    .map((d) => ({ ...(d.data() as FieldworkAuth), id: d.id }))
    .filter((f) => f.active && f.startAt <= at);
}

export function fieldworkTargets(list: FieldworkAuth[]): GeofenceTarget[] {
  return list
    .filter((f) => f.mode === 'alternate_location' && f.lat != null && f.lng != null && f.radiusMeters)
    .map((f) => ({
      id: `fieldwork:${f.id}`,
      name: f.category === 'wfh' ? `Work from home${f.locationName ? ` (${f.locationName})` : ''}` : f.locationName || 'Approved fieldwork location',
      lat: f.lat!,
      lng: f.lng!,
      radiusMeters: f.radiusMeters!,
    }));
}

export async function leavesFor(orgId: string, from: string, to: string, memberId?: string): Promise<LeaveDoc[]> {
  let q = col(orgId, 'leaves').where('from', '<=', to);
  if (memberId) q = q.where('memberId', '==', memberId);
  const snap = await q.get();
  return snap.docs.map((d) => ({ ...(d.data() as LeaveDoc), id: d.id })).filter((l) => l.to >= from);
}

export function onLeave(leaves: LeaveDoc[], memberId: string, date: string) {
  return leaves.some((l) => l.memberId === memberId && l.from <= date && l.to >= date);
}

export async function fieldworkInRange(orgId: string, fromMs: number, toMs: number, memberId?: string): Promise<FieldworkAuth[]> {
  let q = col(orgId, 'fieldworkAuthorizations').where('endAt', '>=', fromMs);
  if (memberId) q = q.where('memberId', '==', memberId);
  const snap = await q.get();
  return snap.docs.map((d) => ({ ...(d.data() as FieldworkAuth), id: d.id })).filter((f) => f.active && f.startAt <= toMs);
}

export const categoryOf = (f: Pick<FieldworkAuth, 'category'>) => f.category ?? 'fieldwork';

export function fieldworkOnPlan(list: FieldworkAuth[], memberId: string, plan: ShiftPlan, tz: string, category: 'fieldwork' | 'wfh' = 'fieldwork'): boolean {
  return list.some((f) => {
    if (f.memberId !== memberId || categoryOf(f) !== category) return false;
    if (plan.sessions.length) return f.startAt < plan.sessions[plan.sessions.length - 1].end && f.endAt > plan.sessions[0].start;
    return localDate(f.startAt, tz) <= plan.workDate && localDate(f.endAt, tz) >= plan.workDate;
  });
}

/**
 * Recomputes a shift document from its immutable sources (accepted events and
 * approved adjustments). Used after corrections and by the rebuild operation,
 * so summaries can always be regenerated and drift can be detected.
 */
export async function rebuildShift(
  tx: Transaction,
  orgId: string,
  member: Pick<MemberDoc, 'uid' | 'departmentId'>,
  workDate: string,
  planIfMissing: () => ShiftPlan,
  extraAdjustment?: { action: AttendanceAction; after: number | null; createdAt: number },
): Promise<{ ref: FirebaseFirestore.DocumentReference; doc: ShiftDoc; changed: boolean }> {
  const ref = col(orgId, 'shiftInstances').doc(shiftId(member.uid, workDate));
  const [shiftSnap, evSnap, adjSnap] = await Promise.all([
    tx.get(ref),
    tx.get(col(orgId, 'attendanceEvents').where('memberId', '==', member.uid).where('workDate', '==', workDate)),
    tx.get(col(orgId, 'adjustments').where('memberId', '==', member.uid).where('workDate', '==', workDate)),
  ]);
  const events = evSnap.docs.map((d) => ({ action: d.get('action') as AttendanceAction, at: d.get('at') as number, id: d.id }));
  const adjustments = adjSnap.docs.map((d) => ({ action: d.get('action') as AttendanceAction, after: d.get('after') as number | null, createdAt: d.get('createdAt') as number }));
  if (extraAdjustment) adjustments.push(extraAdjustment);
  const { punches, corrected } = effectivePunches(events, adjustments);
  const eventIds: Partial<Record<AttendanceAction, string>> = {};
  for (const e of events.sort((a, b) => a.at - b.at)) if (!eventIds[e.action]) eventIds[e.action] = e.id;
  const existing = shiftSnap.exists ? (shiftSnap.data() as ShiftDoc) : null;
  const doc: ShiftDoc = {
    orgId,
    memberId: member.uid,
    departmentId: existing?.departmentId ?? member.departmentId,
    workDate,
    plan: existing?.plan ?? planIfMissing(),
    punches,
    correctedActions: corrected,
    eventIds,
    version: (existing?.version ?? 0) + 1,
    updatedAt: Date.now(),
  };
  const changed =
    !existing ||
    JSON.stringify(sortKeys(existing.punches)) !== JSON.stringify(sortKeys(punches)) ||
    JSON.stringify([...(existing.correctedActions ?? [])].sort()) !== JSON.stringify([...corrected].sort());
  return { ref, doc, changed };
}

function sortKeys(o: Record<string, unknown> = {}) {
  return Object.fromEntries(Object.entries(o).sort(([a], [b]) => a.localeCompare(b)));
}

export async function loadShifts(orgId: string, from: string, to: string, filter?: { memberId?: string; departmentId?: string }) {
  let q = col(orgId, 'shiftInstances').where('workDate', '>=', from).where('workDate', '<=', to);
  if (filter?.memberId) q = col(orgId, 'shiftInstances').where('memberId', '==', filter.memberId).where('workDate', '>=', from).where('workDate', '<=', to);
  const snap = await q.get();
  const map = new Map<string, ShiftDoc>();
  for (const d of snap.docs) map.set(d.id, d.data() as ShiftDoc);
  return map;
}

export async function loadMembers(orgId: string): Promise<MemberDoc[]> {
  const snap = await col(orgId, 'members').get();
  return snap.docs.map((d) => ({ ...(d.data() as MemberDoc), uid: d.id }));
}

export const datesAround = (today: string) => ({ yesterday: addDays(today, -1), today, tomorrow: addDays(today, 1) });

export { db };
