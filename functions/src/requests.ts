import type { Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { actionSequence } from '../../shared/attendance';
import { canReviewRequest } from '../../shared/roles';
import { addDays, isValidDate, localDate, zonedToUtc } from '../../shared/time';
import { ALL_ACTIONS, type AttendanceAction, type MemberDoc, type RequestType } from '../../shared/types';
import { audit, col, db, type Caller } from './context';
import { loadScheduleContext, planFor, rebuildShift, shiftId, type ShiftDoc } from './data';

const dateStr = z.string().refine(isValidDate, 'Invalid date');
const localDateTime = z.string().regex(/^\d{4}-\d{2}-\d{2}T([01]\d|2[0-3]):[0-5]\d$/, 'Use YYYY-MM-DDTHH:mm');
const action = z.enum(ALL_ACTIONS as [AttendanceAction, ...AttendanceAction[]]);

export function localDateTimeToUtc(v: string, tz: string): number {
  const [d, t] = v.split('T');
  const [h, m] = t.split(':').map(Number);
  return zonedToUtc(d, h * 60 + m, tz);
}

export const submitSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('missing_punch'), workDate: dateStr, action, proposedAt: localDateTime, explanation: z.string().trim().min(5).max(1000) }),
  z.object({ type: z.literal('incorrect_punch'), workDate: dateStr, action, proposedAt: localDateTime, explanation: z.string().trim().min(5).max(1000) }),
  z.object({ type: z.literal('explanation'), workDate: dateStr, explanation: z.string().trim().min(5).max(1000) }),
  z.object({ type: z.literal('overtime'), workDate: dateStr, minutes: z.number().int().min(1).max(720), explanation: z.string().trim().min(5).max(1000) }),
  z.object({
    type: z.literal('fieldwork'),
    workDate: dateStr,
    explanation: z.string().trim().min(5).max(1000),
    fieldwork: z.object({
      startAt: localDateTime,
      endAt: localDateTime,
      mode: z.enum(['alternate_location', 'exemption']),
      purpose: z.string().trim().min(3).max(200),
      locationName: z.string().trim().max(120).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      radiusMeters: z.number().int().min(10).max(5000).optional(),
    }),
  }),
]);

const MAX_PAST_DAYS = 60;
const MAX_FUTURE_DAYS = 60;

export async function submitRequest(caller: Caller, raw: unknown, now = Date.now()) {
  const parsed = submitSchema.safeParse(raw);
  if (!parsed.success) throw new HttpsError('invalid-argument', parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '));
  const input = parsed.data;
  const tz = caller.org.settings.timezone;
  const today = localDate(now, tz);
  if (input.workDate < addDays(today, -MAX_PAST_DAYS)) throw new HttpsError('invalid-argument', `Requests must be within ${MAX_PAST_DAYS} days.`);
  const futureAllowed = input.type === 'fieldwork' ? MAX_FUTURE_DAYS : 0;
  if (input.workDate > addDays(today, futureAllowed)) throw new HttpsError('invalid-argument', 'That date is in the future.');

  const doc: Record<string, unknown> = {
    orgId: caller.orgId,
    memberId: caller.uid,
    memberName: caller.member.fullName,
    employeeNumber: caller.member.employeeNumber,
    departmentId: caller.member.departmentId,
    type: input.type,
    workDate: input.workDate,
    explanation: input.explanation,
    status: 'pending',
    createdAt: now,
    reviewerUid: null,
    reviewerName: null,
    reviewerRemarks: null,
    reviewedAt: null,
    action: null,
    proposedAt: null,
    fieldwork: null,
    minutes: null,
  };

  if (input.type === 'missing_punch' || input.type === 'incorrect_punch') {
    const proposed = localDateTimeToUtc(input.proposedAt, tz);
    const lo = zonedToUtc(input.workDate, -12 * 60, tz);
    const hi = zonedToUtc(addDays(input.workDate, 2), 0, tz);
    if (proposed < lo || proposed >= hi) throw new HttpsError('invalid-argument', 'The proposed time must be within the shift’s work date (or the next morning for overnight shifts).');
    if (proposed > now) throw new HttpsError('invalid-argument', 'The proposed time cannot be in the future.');
    const shift = await col(caller.orgId, 'shiftInstances').doc(shiftId(caller.uid, input.workDate)).get();
    const current = (shift.get('punches') ?? {}) as Record<string, number>;
    if (input.type === 'missing_punch' && current[input.action] != null)
      throw new HttpsError('failed-precondition', 'That action is already recorded. Use “Incorrect attendance” instead.');
    if (input.type === 'incorrect_punch' && current[input.action] == null)
      throw new HttpsError('failed-precondition', 'That action has no recorded time. Use “Missing clock-in/out” instead.');
    doc.action = input.action;
    doc.proposedAt = proposed;
    doc.currentAt = current[input.action] ?? null;
  }
  if (input.type === 'overtime') doc.minutes = input.minutes;
  if (input.type === 'fieldwork') {
    const f = input.fieldwork;
    const startAt = localDateTimeToUtc(f.startAt, tz);
    const endAt = localDateTimeToUtc(f.endAt, tz);
    if (endAt <= startAt) throw new HttpsError('invalid-argument', 'Fieldwork end must be after start.');
    if (endAt - startAt > 14 * 86_400_000) throw new HttpsError('invalid-argument', 'Fieldwork windows are limited to 14 days per request.');
    if (f.mode === 'alternate_location' && (f.lat == null || f.lng == null || !f.radiusMeters || !f.locationName))
      throw new HttpsError('invalid-argument', 'Alternate locations need a name, coordinates, and radius.');
    doc.fieldwork = {
      startAt,
      endAt,
      mode: f.mode,
      purpose: f.purpose,
      locationName: f.mode === 'alternate_location' ? f.locationName : null,
      lat: f.mode === 'alternate_location' ? f.lat : null,
      lng: f.mode === 'alternate_location' ? f.lng : null,
      radiusMeters: f.mode === 'alternate_location' ? f.radiusMeters : null,
    };
  }

  const ref = col(caller.orgId, 'correctionRequests').doc();
  await db.runTransaction(async (tx) => {
    const dup = await tx.get(
      col(caller.orgId, 'correctionRequests')
        .where('memberId', '==', caller.uid)
        .where('workDate', '==', input.workDate)
        .where('type', '==', input.type)
        .where('status', '==', 'pending'),
    );
    if (dup.docs.some((d) => (d.get('action') ?? null) === (doc.action ?? null)))
      throw new HttpsError('already-exists', 'You already have a pending request of this type for that date.');
    tx.create(ref, doc);
    audit(tx, caller, { action: 'request.submit', targetType: 'correctionRequest', targetId: ref.id, after: doc });
  });
  return { id: ref.id };
}

export async function cancelRequest(caller: Caller, raw: unknown) {
  const { id } = z.object({ id: z.string().min(1).max(128) }).parse(raw);
  const ref = col(caller.orgId, 'correctionRequests').doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists || snap.get('memberId') !== caller.uid) throw new HttpsError('not-found', 'Request not found.');
    if (snap.get('status') !== 'pending') throw new HttpsError('failed-precondition', 'Only pending requests can be cancelled.');
    tx.update(ref, { status: 'cancelled', reviewedAt: Date.now() });
    audit(tx, caller, { action: 'request.cancel', targetType: 'correctionRequest', targetId: id });
  });
  return { ok: true };
}

/** Checks the effective punches follow the action sequence in time order. */
export function sequenceIsConsistent(pattern: 'single' | 'split', punches: Partial<Record<AttendanceAction, number>>, unscheduled: boolean) {
  const seq = actionSequence(unscheduled ? 'single' : pattern);
  let last = -Infinity;
  for (const a of seq) {
    const t = punches[a];
    if (t == null) continue;
    if (t < last) return false;
    last = t;
  }
  return Object.keys(punches).every((k) => seq.includes(k as AttendanceAction));
}

/**
 * Records an approved adjustment as a separate immutable document with the
 * before/after values and recomputes the shift. Original events are untouched.
 */
export async function applyAdjustment(
  tx: Transaction,
  caller: Caller,
  member: MemberDoc,
  workDate: string,
  actionName: AttendanceAction,
  after: number | null,
  reason: string,
  requestId: string | null,
  planIfMissing: () => import('../../shared/types').ShiftPlan,
) {
  const createdAt = Date.now();
  const shiftRef = col(caller.orgId, 'shiftInstances').doc(shiftId(member.uid, workDate));
  const prevSnap = await tx.get(shiftRef);
  const prev = prevSnap.exists ? (prevSnap.data() as ShiftDoc) : null;
  const { ref, doc } = await rebuildShift(tx, caller.orgId, member, workDate, planIfMissing, { action: actionName, after, createdAt });
  if (!sequenceIsConsistent(doc.plan.pattern, doc.punches, doc.plan.unscheduled)) {
    throw new HttpsError('failed-precondition', 'This adjustment would put the attendance actions out of order. Adjust the other actions first.');
  }
  const adjRef = col(caller.orgId, 'adjustments').doc();
  const adjustment = {
    orgId: caller.orgId,
    memberId: member.uid,
    memberName: member.fullName,
    departmentId: doc.departmentId,
    workDate,
    shiftInstanceId: ref.id,
    action: actionName,
    before: prev?.punches?.[actionName] ?? null,
    after,
    originalEventId: prev?.eventIds?.[actionName] ?? null,
    reason,
    requestId,
    reviewerUid: caller.uid,
    reviewerName: caller.member.fullName,
    createdAt,
  };
  tx.create(adjRef, adjustment);
  tx.set(ref, doc);
  audit(tx, caller, { action: 'attendance.adjust', targetType: 'adjustment', targetId: adjRef.id, before: adjustment.before, after: adjustment, reason });
  return adjRef.id;
}

export const reviewSchema = z.object({
  id: z.string().min(1).max(128),
  decision: z.enum(['approve', 'reject']),
  remarks: z.string().trim().max(1000).default(''),
});

export async function reviewRequest(caller: Caller, raw: unknown) {
  const input = reviewSchema.parse(raw);
  if (input.decision === 'reject' && input.remarks.length < 3) throw new HttpsError('invalid-argument', 'Please give a reason for rejecting.');
  const ref = col(caller.orgId, 'correctionRequests').doc(input.id);
  const pre = await ref.get();
  if (!pre.exists) throw new HttpsError('not-found', 'Request not found.');
  const memberSnap = await col(caller.orgId, 'members').doc(pre.get('memberId')).get();
  if (!memberSnap.exists) throw new HttpsError('not-found', 'Employee not found.');
  const member = { ...(memberSnap.data() as MemberDoc), uid: memberSnap.id };
  const tz = caller.org.settings.timezone;
  const workDate = pre.get('workDate') as string;
  const sctx = await loadScheduleContext(caller.orgId, tz, workDate, workDate, [member.uid]);

  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const req = snap.data()!;
    const perm = canReviewRequest(caller.member, { memberId: req.memberId, departmentId: req.departmentId }, caller.org.settings.approvalMode);
    if (!perm.ok) throw new HttpsError('permission-denied', perm.reason);
    if (req.status !== 'pending') throw new HttpsError('failed-precondition', `This request was already ${req.status}.`);
    const result: Record<string, unknown> = {};
    if (input.decision === 'approve') {
      const type = req.type as RequestType;
      if (type === 'missing_punch' || type === 'incorrect_punch') {
        result.adjustmentId = await applyAdjustment(tx, caller, member, workDate, req.action, req.proposedAt, `Request ${snap.id}: ${req.explanation}`, snap.id, () =>
          planFor(sctx, member.uid, workDate),
        );
      } else if (type === 'fieldwork') {
        const fwRef = col(caller.orgId, 'fieldworkAuthorizations').doc();
        tx.create(fwRef, {
          ...req.fieldwork,
          orgId: caller.orgId,
          memberId: req.memberId,
          memberName: req.memberName,
          departmentId: req.departmentId,
          workDate,
          requestId: snap.id,
          approvedBy: caller.uid,
          approvedByName: caller.member.fullName,
          approvedAt: Date.now(),
          active: true,
        });
        result.fieldworkAuthorizationId = fwRef.id;
      } else if (type === 'overtime') {
        const otRef = col(caller.orgId, 'overtimeApprovals').doc();
        tx.create(otRef, {
          orgId: caller.orgId,
          memberId: req.memberId,
          departmentId: req.departmentId,
          workDate,
          minutes: req.minutes,
          requestId: snap.id,
          approvedBy: caller.uid,
          approvedAt: Date.now(),
        });
        result.overtimeApprovalId = otRef.id;
      }
    }
    const update = {
      status: input.decision === 'approve' ? 'approved' : 'rejected',
      reviewerUid: caller.uid,
      reviewerName: caller.member.fullName,
      reviewerRemarks: input.remarks || null,
      reviewedAt: Date.now(),
      ...result,
    };
    tx.update(ref, update);
    audit(tx, caller, { action: `request.${input.decision}`, targetType: 'correctionRequest', targetId: snap.id, before: { status: req.status }, after: update, reason: input.remarks });
    return { ok: true, ...update };
  });
}
