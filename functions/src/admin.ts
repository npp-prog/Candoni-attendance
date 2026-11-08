import { randomBytes } from 'node:crypto';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { LIMITS } from '../../shared/defaults';
import { isAttendanceAdmin } from '../../shared/roles';
import { validateSchedule } from '../../shared/schedule';
import { isValidDate, isValidTimeZone, localDate, TIME_RE } from '../../shared/time';
import { ALL_ACTIONS, ROLES, type AttendanceAction, type MemberDoc } from '../../shared/types';
import { audit, auth, col, db, orgRef, requireRole, type Caller } from './context';
import { loadScheduleContext, planFor, rebuildShift } from './data';
import { applyAdjustment } from './requests';

const HR = ['hr', 'sysadmin'] as const;
const id = z.string().min(1).max(128).regex(/^[A-Za-z0-9_-]+$/);
const dateStr = z.string().refine(isValidDate, 'Invalid date');
const text = (max: number) => z.string().trim().max(max);

function parse<T extends z.ZodTypeAny>(schema: T, raw: unknown): z.infer<T> {
  const r = schema.safeParse(raw);
  if (!r.success) throw new HttpsError('invalid-argument', r.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
  return r.data;
}

async function getMember(orgId: string, uid: string): Promise<MemberDoc> {
  const snap = await col(orgId, 'members').doc(uid).get();
  if (!snap.exists) throw new HttpsError('not-found', 'Employee not found.');
  return { ...(snap.data() as MemberDoc), uid: snap.id };
}

async function assertExists(orgId: string, collection: 'departments' | 'workplaces' | 'schedules' | 'members', ids: string[]) {
  const unique = [...new Set(ids.filter(Boolean))];
  const snaps = await Promise.all(unique.map((i) => col(orgId, collection).doc(i).get()));
  const missing = unique.filter((_, i) => !snaps[i].exists);
  if (missing.length) throw new HttpsError('invalid-argument', `Unknown ${collection}: ${missing.join(', ')}`);
}

/** HR may manage employees and supervisors; editing HR/sysadmin accounts needs a sysadmin. */
function assertCanManage(caller: Caller, target: MemberDoc) {
  requireRole(caller, [...HR], 'manage employees');
  if (target.uid === caller.uid && caller.member.role !== 'sysadmin')
    throw new HttpsError('permission-denied', 'You cannot change your own assignments. Ask another administrator.');
  if (isAttendanceAdmin(target.role) && caller.member.role !== 'sysadmin')
    throw new HttpsError('permission-denied', 'Only a system administrator can modify administrator accounts.');
}

const profileSchema = z.object({
  employeeNumber: text(40).min(1),
  fullName: text(120).min(1),
  email: z.string().trim().toLowerCase().email().max(200),
  departmentId: id,
  position: text(120),
  classification: text(80),
  supervisorUid: id.nullable(),
  workplaceIds: z.array(id).max(50).default([]),
});

export async function createEmployee(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'create employees');
  const input = parse(profileSchema.extend({ role: z.enum(ROLES as [string, ...string[]]).default('employee') }), raw);
  if (input.role !== 'employee' && caller.member.role !== 'sysadmin') throw new HttpsError('permission-denied', 'Only a system administrator can assign elevated roles.');
  await assertExists(caller.orgId, 'departments', [input.departmentId]);
  await assertExists(caller.orgId, 'workplaces', input.workplaceIds);
  if (input.supervisorUid) await assertExists(caller.orgId, 'members', [input.supervisorUid]);
  const dupNumber = await col(caller.orgId, 'members').where('employeeNumber', '==', input.employeeNumber).limit(1).get();
  if (!dupNumber.empty) throw new HttpsError('already-exists', 'That employee number is already in use.');

  let user;
  try {
    user = await auth().createUser({
      email: input.email,
      displayName: input.fullName,
      // Random throwaway password; the employee sets their own via the reset link.
      password: randomBytes(24).toString('base64url'),
      emailVerified: false,
    });
  } catch (e) {
    const code = (e as { code?: string }).code;
    if (code === 'auth/email-already-exists') throw new HttpsError('already-exists', 'An account with that email already exists.');
    throw e;
  }
  const supervisorName = input.supervisorUid ? (await getMember(caller.orgId, input.supervisorUid)).fullName : null;
  const member: MemberDoc & { supervisorName: string | null } = {
    uid: user.uid,
    orgId: caller.orgId,
    employeeNumber: input.employeeNumber,
    fullName: input.fullName,
    email: input.email,
    departmentId: input.departmentId,
    position: input.position,
    classification: input.classification,
    supervisorUid: input.supervisorUid,
    supervisorName,
    role: input.role as MemberDoc['role'],
    supervisedDepartmentIds: [],
    workplaceIds: input.workplaceIds,
    active: true,
    privacyAcceptedVersion: null,
  };
  const batch = db.batch();
  batch.set(db.collection('users').doc(user.uid), { orgId: caller.orgId, createdAt: Date.now() });
  batch.set(col(caller.orgId, 'members').doc(user.uid), { ...member, createdAt: Date.now(), searchName: member.fullName.toLowerCase() });
  audit(batch, caller, { action: 'employee.create', targetType: 'member', targetId: user.uid, after: member });
  await batch.commit();
  let resetLink: string | null = null;
  try {
    resetLink = await auth().generatePasswordResetLink(input.email);
  } catch {
    resetLink = null;
  }
  return { uid: user.uid, resetLink };
}

export async function updateEmployee(caller: Caller, raw: unknown) {
  const input = parse(profileSchema.extend({ uid: id }), raw);
  const target = await getMember(caller.orgId, input.uid);
  assertCanManage(caller, target);
  await assertExists(caller.orgId, 'departments', [input.departmentId]);
  await assertExists(caller.orgId, 'workplaces', input.workplaceIds);
  if (input.supervisorUid) {
    if (input.supervisorUid === input.uid) throw new HttpsError('invalid-argument', 'An employee cannot supervise themselves.');
    await assertExists(caller.orgId, 'members', [input.supervisorUid]);
  }
  if (input.employeeNumber !== target.employeeNumber) {
    const dup = await col(caller.orgId, 'members').where('employeeNumber', '==', input.employeeNumber).limit(1).get();
    if (!dup.empty) throw new HttpsError('already-exists', 'That employee number is already in use.');
  }
  if (input.email !== target.email) await auth().updateUser(input.uid, { email: input.email });
  const { uid, ...rest } = input;
  const supervisorName = rest.supervisorUid ? (await getMember(caller.orgId, rest.supervisorUid)).fullName : null;
  const fields = { ...rest, supervisorName };
  const batch = db.batch();
  batch.update(col(caller.orgId, 'members').doc(uid), { ...fields, searchName: fields.fullName.toLowerCase() });
  audit(batch, caller, { action: 'employee.update', targetType: 'member', targetId: uid, before: pick(target, Object.keys(fields)), after: fields });
  await batch.commit();
  return { ok: true };
}

function pick(o: object, keys: string[]) {
  return Object.fromEntries(keys.map((k) => [k, (o as Record<string, unknown>)[k]]));
}

export async function setEmployeeActive(caller: Caller, raw: unknown) {
  const input = parse(z.object({ uid: id, active: z.boolean(), reason: text(500).default('') }), raw);
  const target = await getMember(caller.orgId, input.uid);
  if (input.uid === caller.uid) throw new HttpsError('permission-denied', 'You cannot change your own status.');
  assertCanManage(caller, target);
  if (!input.active && target.role === 'sysadmin') await assertAnotherSysadmin(caller.orgId, input.uid);
  // Disable the Auth account and revoke refresh tokens; the member flag is also
  // checked on every backend call and in security rules, so existing sessions lose access.
  await auth().updateUser(input.uid, { disabled: !input.active });
  if (!input.active) await auth().revokeRefreshTokens(input.uid);
  const batch = db.batch();
  batch.update(col(caller.orgId, 'members').doc(input.uid), { active: input.active });
  audit(batch, caller, { action: input.active ? 'employee.activate' : 'employee.deactivate', targetType: 'member', targetId: input.uid, before: { active: target.active }, after: { active: input.active }, reason: input.reason });
  await batch.commit();
  return { ok: true };
}

async function assertAnotherSysadmin(orgId: string, excludingUid: string) {
  const snap = await col(orgId, 'members').where('role', '==', 'sysadmin').where('active', '==', true).get();
  if (!snap.docs.some((d) => d.id !== excludingUid)) throw new HttpsError('failed-precondition', 'At least one active system administrator must remain.');
}

export async function setRole(caller: Caller, raw: unknown) {
  requireRole(caller, ['sysadmin'], 'change roles');
  const input = parse(z.object({ uid: id, role: z.enum(ROLES as [string, ...string[]]), supervisedDepartmentIds: z.array(id).max(50).default([]) }), raw);
  if (input.uid === caller.uid) throw new HttpsError('permission-denied', 'You cannot change your own role.');
  const target = await getMember(caller.orgId, input.uid);
  await assertExists(caller.orgId, 'departments', input.supervisedDepartmentIds);
  if (target.role === 'sysadmin' && input.role !== 'sysadmin') await assertAnotherSysadmin(caller.orgId, input.uid);
  const after = { role: input.role, supervisedDepartmentIds: input.role === 'supervisor' ? input.supervisedDepartmentIds : [] };
  const batch = db.batch();
  batch.update(col(caller.orgId, 'members').doc(input.uid), after);
  audit(batch, caller, { action: 'role.change', targetType: 'member', targetId: input.uid, before: { role: target.role, supervisedDepartmentIds: target.supervisedDepartmentIds }, after });
  await batch.commit();
  return { ok: true };
}

export async function resetLink(caller: Caller, raw: unknown) {
  const { uid } = parse(z.object({ uid: id }), raw);
  const target = await getMember(caller.orgId, uid);
  assertCanManage(caller, target);
  return { resetLink: await auth().generatePasswordResetLink(target.email), email: target.email };
}

async function upsert(caller: Caller, collection: 'departments' | 'workplaces' | 'schedules' | 'holidays' | 'leaves', docId: string | undefined, data: Record<string, unknown>, auditAction: string) {
  const ref = docId ? col(caller.orgId, collection).doc(docId) : col(caller.orgId, collection).doc();
  await db.runTransaction(async (tx) => {
    const prev = await tx.get(ref);
    if (docId && !prev.exists) throw new HttpsError('not-found', 'Record not found.');
    tx.set(ref, { ...data, orgId: caller.orgId, updatedAt: Date.now(), updatedBy: caller.uid }, { merge: false });
    audit(tx, caller, { action: auditAction, targetType: collection, targetId: ref.id, before: prev.exists ? prev.data() : null, after: data });
  });
  return { id: ref.id };
}

export async function upsertDepartment(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'manage departments');
  const input = parse(z.object({ id: id.optional(), name: text(120).min(1), code: text(20).default(''), active: z.boolean().default(true) }), raw);
  const { id: docId, ...data } = input;
  return upsert(caller, 'departments', docId, data, 'department.upsert');
}

export async function upsertWorkplace(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'manage workplaces');
  const input = parse(
    z.object({
      id: id.optional(),
      name: text(120).min(1),
      address: text(300).default(''),
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      radiusMeters: z.number().int().min(LIMITS.minRadiusMeters).max(LIMITS.maxRadiusMeters),
      active: z.boolean().default(true),
      departmentIds: z.array(id).max(100).default([]),
      memberIds: z.array(id).max(1000).default([]),
    }),
    raw,
  );
  await assertExists(caller.orgId, 'departments', input.departmentIds);
  const { id: docId, ...data } = input;
  return upsert(caller, 'workplaces', docId, data, 'workplace.upsert');
}

const scheduleSchema = z.object({
  id: id.optional(),
  name: text(120).min(1),
  pattern: z.enum(['single', 'split']),
  sessions: z.array(z.object({ start: z.string().regex(TIME_RE), end: z.string().regex(TIME_RE) })).min(1).max(2),
  workDays: z.array(z.number().int().min(0).max(6)).max(7),
  graceMinutes: z.number().int(),
  breakStart: z.string().regex(TIME_RE).nullable().default(null),
  breakEnd: z.string().regex(TIME_RE).nullable().default(null),
  flexible: z.boolean().default(false),
  flexMinutes: z.number().int().default(0),
  earlyInMinutes: z.number().int().default(120),
  cutoffMinutes: z.number().int().default(240),
  overtimeThresholdMinutes: z.number().int().default(30),
  active: z.boolean().default(true),
});

export async function upsertSchedule(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'manage schedules');
  const input = parse(scheduleSchema, raw);
  const err = validateSchedule(input);
  if (err) throw new HttpsError('invalid-argument', err);
  const { id: docId, ...data } = input;
  data.workDays = [...new Set(data.workDays)].sort();
  return upsert(caller, 'schedules', docId, data, 'schedule.upsert');
}

export async function createAssignment(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'assign schedules');
  const input = parse(z.object({ memberId: id, scheduleId: id, effectiveFrom: dateStr, effectiveTo: dateStr.nullable().default(null) }), raw);
  if (input.effectiveTo && input.effectiveTo < input.effectiveFrom) throw new HttpsError('invalid-argument', 'End date must be on or after start date.');
  await assertExists(caller.orgId, 'members', [input.memberId]);
  await assertExists(caller.orgId, 'schedules', [input.scheduleId]);
  const ref = col(caller.orgId, 'scheduleAssignments').doc();
  await db.runTransaction(async (tx) => {
    const same = await tx.get(col(caller.orgId, 'scheduleAssignments').where('memberId', '==', input.memberId).where('effectiveFrom', '==', input.effectiveFrom));
    if (!same.empty) throw new HttpsError('already-exists', 'An assignment already starts on that date. End or remove it first.');
    tx.create(ref, { ...input, orgId: caller.orgId, createdAt: Date.now(), createdBy: caller.uid });
    audit(tx, caller, { action: 'schedule.assign', targetType: 'scheduleAssignment', targetId: ref.id, after: input });
  });
  return { id: ref.id };
}

export async function endAssignment(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'assign schedules');
  const input = parse(z.object({ id, effectiveTo: dateStr.nullable(), remove: z.boolean().default(false) }), raw);
  const ref = col(caller.orgId, 'scheduleAssignments').doc(input.id);
  const today = localDate(Date.now(), caller.org.settings.timezone);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Assignment not found.');
    const before = snap.data()!;
    if (input.remove) {
      // Only future assignments may be removed; past ones are history and must be ended instead.
      if (before.effectiveFrom <= today) throw new HttpsError('failed-precondition', 'Assignments already in effect cannot be removed; set an end date instead.');
      tx.delete(ref);
    } else {
      if (input.effectiveTo && input.effectiveTo < before.effectiveFrom) throw new HttpsError('invalid-argument', 'End date is before the start date.');
      tx.update(ref, { effectiveTo: input.effectiveTo });
    }
    audit(tx, caller, { action: input.remove ? 'schedule.unassign' : 'schedule.assignment_end', targetType: 'scheduleAssignment', targetId: input.id, before, after: input });
  });
  return { ok: true };
}

export async function upsertHoliday(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'manage holidays');
  const input = parse(z.object({ id: id.optional(), date: dateStr, name: text(120).min(1), type: z.enum(['regular', 'special', 'company']) }), raw);
  const { id: docId, ...data } = input;
  const dup = await col(caller.orgId, 'holidays').where('date', '==', data.date).get();
  if (dup.docs.some((d) => d.id !== docId)) throw new HttpsError('already-exists', 'A holiday already exists on that date.');
  return upsert(caller, 'holidays', docId, data, 'holiday.upsert');
}

export async function deleteRecord(caller: Caller, raw: unknown, collection: 'holidays' | 'leaves') {
  requireRole(caller, [...HR], `manage ${collection}`);
  const { id: docId } = parse(z.object({ id }), raw);
  const ref = col(caller.orgId, collection).doc(docId);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Record not found.');
    tx.delete(ref);
    audit(tx, caller, { action: `${collection}.delete`, targetType: collection, targetId: docId, before: snap.data() });
  });
  return { ok: true };
}

export async function upsertLeave(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'record leave');
  const input = parse(z.object({ id: id.optional(), memberId: id, from: dateStr, to: dateStr, type: text(60).min(1), note: text(500).default('') }), raw);
  if (input.to < input.from) throw new HttpsError('invalid-argument', 'Leave end is before start.');
  const target = await getMember(caller.orgId, input.memberId);
  if (target.uid === caller.uid) throw new HttpsError('permission-denied', 'You cannot record your own leave.');
  const { id: docId, ...data } = input;
  return upsert(caller, 'leaves', docId, { ...data, departmentId: target.departmentId, memberName: target.fullName }, 'leave.upsert');
}

export async function revokeFieldwork(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'revoke fieldwork');
  const input = parse(z.object({ id, reason: text(500).min(3) }), raw);
  const ref = col(caller.orgId, 'fieldworkAuthorizations').doc(input.id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Authorization not found.');
    tx.update(ref, { active: false, revokedBy: caller.uid, revokedAt: Date.now(), revokeReason: input.reason });
    audit(tx, caller, { action: 'fieldwork.revoke', targetType: 'fieldworkAuthorization', targetId: input.id, reason: input.reason });
  });
  return { ok: true };
}

export async function createAdjustment(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'adjust attendance');
  const input = parse(
    z.object({
      memberId: id,
      workDate: dateStr,
      action: z.enum(ALL_ACTIONS as [AttendanceAction, ...AttendanceAction[]]),
      at: z.number().int().nullable(),
      reason: text(1000).min(5),
    }),
    raw,
  );
  if (input.memberId === caller.uid) throw new HttpsError('permission-denied', 'You cannot adjust your own attendance.');
  if (input.at != null && input.at > Date.now()) throw new HttpsError('invalid-argument', 'Adjusted time cannot be in the future.');
  const member = await getMember(caller.orgId, input.memberId);
  const tz = caller.org.settings.timezone;
  const sctx = await loadScheduleContext(caller.orgId, tz, input.workDate, input.workDate, [member.uid]);
  const adjustmentId = await db.runTransaction((tx) =>
    applyAdjustment(tx, caller, member, input.workDate, input.action, input.at, input.reason, null, () => planFor(sctx, member.uid, input.workDate)),
  );
  return { adjustmentId };
}

const settingsSchema = z.object({
  name: text(120).min(1),
  shortName: text(40).min(1),
  logoUrl: z
    .string()
    .max(280_000)
    .refine((v) => /^https:\/\//.test(v) || /^data:image\/(png|jpeg|webp|svg\+xml);base64,[A-Za-z0-9+/=]+$/.test(v), 'Logo must be an https URL or a base64 image')
    .nullable(),
  settings: z.object({
    timezone: z.string().refine(isValidTimeZone, 'Unknown IANA timezone'),
    maxAccuracyMeters: z.number().int().min(LIMITS.minAccuracyMeters).max(LIMITS.maxAccuracyMeters),
    maxLocationAgeSeconds: z.number().int().min(10).max(LIMITS.maxLocationAgeSeconds),
    minActionIntervalSeconds: z.number().int().min(10).max(3600),
    allowUnscheduledAttendance: z.boolean(),
    unscheduledMaxHours: z.number().int().min(1).max(24),
    approvalMode: z.enum(['supervisor_or_hr', 'hr_only']),
    privacyNoticeVersion: z.number().int().min(1),
    privacyNoticeText: text(8000).min(20),
    retention: z.object({
      enabled: z.boolean(),
      rejectedAttemptDays: z.number().int().min(30).max(3650),
      locationEvidenceDays: z.number().int().min(90).max(3650),
    }),
  }),
});

export async function updateSettings(caller: Caller, raw: unknown) {
  requireRole(caller, ['sysadmin'], 'change organization settings');
  const input = parse(settingsSchema, raw);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(orgRef(caller.orgId));
    const before = snap.data();
    if (input.settings.privacyNoticeVersion < (before?.settings?.privacyNoticeVersion ?? 1))
      throw new HttpsError('invalid-argument', 'The privacy notice version cannot go backwards.');
    tx.set(orgRef(caller.orgId), { ...input, updatedAt: Date.now() }, { merge: true });
    // Public, non-sensitive branding so the sign-in screen can show the name and logo.
    tx.set(db.collection('branding').doc(caller.orgId), { name: input.name, shortName: input.shortName, logoUrl: input.logoUrl });
    audit(tx, caller, { action: 'settings.update', targetType: 'organization', targetId: caller.orgId, before: before ? { ...before, logoUrl: before.logoUrl ? '[logo]' : null } : null, after: { ...input, logoUrl: input.logoUrl ? '[logo]' : null } });
  });
  return { ok: true };
}

/** Recomputes shift documents from events and adjustments and reports any drift. */
export async function rebuildSummaries(caller: Caller, raw: unknown) {
  requireRole(caller, [...HR], 'rebuild summaries');
  const input = parse(z.object({ from: dateStr, to: dateStr }), raw);
  if (input.to < input.from) throw new HttpsError('invalid-argument', 'Invalid range.');
  const [shifts, events] = await Promise.all([
    col(caller.orgId, 'shiftInstances').where('workDate', '>=', input.from).where('workDate', '<=', input.to).get(),
    col(caller.orgId, 'attendanceEvents').where('workDate', '>=', input.from).where('workDate', '<=', input.to).select('memberId', 'workDate', 'departmentId').get(),
  ]);
  const keys = new Map<string, { memberId: string; workDate: string; departmentId: string }>();
  for (const d of [...shifts.docs, ...events.docs]) {
    const k = `${d.get('memberId')}_${d.get('workDate')}`;
    if (!keys.has(k)) keys.set(k, { memberId: d.get('memberId'), workDate: d.get('workDate'), departmentId: d.get('departmentId') });
  }
  if (keys.size > 5000) throw new HttpsError('invalid-argument', 'Range too large; rebuild in smaller chunks.');
  const tz = caller.org.settings.timezone;
  const sctx = await loadScheduleContext(caller.orgId, tz, input.from, input.to);
  let changed = 0;
  const drift: string[] = [];
  for (const [k, v] of keys) {
    const res = await db.runTransaction(async (tx) => {
      const r = await rebuildShift(tx, caller.orgId, { uid: v.memberId, departmentId: v.departmentId }, v.workDate, () => planFor(sctx, v.memberId, v.workDate));
      if (r.changed) tx.set(r.ref, r.doc);
      return r.changed;
    });
    if (res) {
      changed++;
      if (drift.length < 50) drift.push(k);
    }
  }
  const batch = db.batch();
  audit(batch, caller, { action: 'summaries.rebuild', targetType: 'shiftInstances', targetId: `${input.from}..${input.to}`, after: { checked: keys.size, changed, drift } });
  await batch.commit();
  return { checked: keys.size, changed, drift };
}
