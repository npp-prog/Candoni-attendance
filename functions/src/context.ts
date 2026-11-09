import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import { getFirestore, type DocumentReference, type Firestore, type Transaction } from 'firebase-admin/firestore';
import { HttpsError } from 'firebase-functions/v2/https';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import type { MemberDoc, OrganizationDoc, OrgSettings } from '../../shared/types';

if (!getApps().length) initializeApp();

/** Firestore database id; production uses a named database (functions/.env.<projectId>). */
export const DATABASE_ID = process.env.FIRESTORE_DATABASE_ID || '(default)';
export const db: Firestore = DATABASE_ID === '(default)' ? getFirestore() : getFirestore(DATABASE_ID);
try {
  db.settings({ ignoreUndefinedProperties: true });
} catch {
  /* settings already applied (hot reload in tests) */
}
export const auth = () => getAuth();

/** All organization data lives under organizations/{orgId}. */
export const orgRef = (orgId: string) => db.collection('organizations').doc(orgId);
export const col = (orgId: string, name: OrgCollection) => orgRef(orgId).collection(name);

export type OrgCollection =
  | 'members'
  | 'departments'
  | 'workplaces'
  | 'schedules'
  | 'scheduleAssignments'
  | 'shiftInstances'
  | 'attendanceEvents'
  | 'attendanceLocationEvidence'
  | 'attendanceAttempts'
  | 'devices'
  | 'webauthnChallenges'
  | 'adjustments'
  | 'correctionRequests'
  | 'fieldworkAuthorizations'
  | 'overtimeApprovals'
  | 'holidays'
  | 'leaves'
  | 'auditLogs'
  | 'rateLimits';

export interface Caller {
  uid: string;
  orgId: string;
  member: MemberDoc;
  org: OrganizationDoc;
}

export function withDefaults(settings: Partial<OrgSettings> | undefined): OrgSettings {
  return {
    ...DEFAULT_SETTINGS,
    ...(settings ?? {}),
    retention: { ...DEFAULT_SETTINGS.retention, ...(settings?.retention ?? {}) },
    deviceBinding: { ...DEFAULT_SETTINGS.deviceBinding, ...(settings?.deviceBinding ?? {}) },
  };
}

export async function loadOrg(orgId: string): Promise<OrganizationDoc> {
  const snap = await orgRef(orgId).get();
  if (!snap.exists) throw new HttpsError('failed-precondition', 'Organization not found.');
  const d = snap.data()!;
  return { id: orgId, name: d.name, shortName: d.shortName ?? d.name, logoUrl: d.logoUrl ?? null, settings: withDefaults(d.settings) };
}

/**
 * Resolves the authenticated user to an organization member. The membership
 * document is read fresh on every call, so deactivation takes effect
 * immediately even for sessions that still hold a valid ID token.
 */
export async function loadCaller(uid: string | undefined, opts: { allowInactive?: boolean } = {}): Promise<Caller> {
  if (!uid) throw new HttpsError('unauthenticated', 'Please sign in.');
  const userSnap = await db.collection('users').doc(uid).get();
  const orgId = userSnap.get('orgId') as string | undefined;
  if (!orgId) throw new HttpsError('permission-denied', 'Your account is not linked to an organization.', { code: 'NOT_A_MEMBER' });
  const [memberSnap, org] = await Promise.all([col(orgId, 'members').doc(uid).get(), loadOrg(orgId)]);
  if (!memberSnap.exists) throw new HttpsError('permission-denied', 'No employee profile found.', { code: 'NOT_A_MEMBER' });
  const member = { ...(memberSnap.data() as MemberDoc), uid };
  if (!member.active && !opts.allowInactive) {
    throw new HttpsError('permission-denied', 'Your account is inactive. Contact HR.', { code: 'ACCOUNT_INACTIVE' });
  }
  return { uid, orgId, member, org };
}

export function requireRole(caller: Caller, roles: MemberDoc['role'][], what = 'perform this action') {
  if (!roles.includes(caller.member.role)) {
    throw new HttpsError('permission-denied', `You do not have permission to ${what}.`);
  }
}

export interface AuditEntry {
  action: string;
  targetType: string;
  targetId: string;
  before?: unknown;
  after?: unknown;
  reason?: string;
}

/** Writes an append-only audit record inside the caller's transaction/batch. */
export function audit(tx: Transaction | FirebaseFirestore.WriteBatch, caller: Pick<Caller, 'uid' | 'orgId' | 'member'>, entry: AuditEntry) {
  const ref = col(caller.orgId, 'auditLogs').doc();
  const doc = {
    orgId: caller.orgId,
    actorUid: caller.uid,
    actorName: caller.member.fullName,
    actorRole: caller.member.role,
    action: entry.action,
    targetType: entry.targetType,
    targetId: entry.targetId,
    before: entry.before === undefined ? null : JSON.parse(JSON.stringify(entry.before)),
    after: entry.after === undefined ? null : JSON.parse(JSON.stringify(entry.after)),
    reason: entry.reason ?? null,
    at: Date.now(),
  };
  (tx as Transaction).set(ref as DocumentReference, doc);
}

/**
 * Fixed-window throttle stored in Firestore. Coarse but effective against
 * accidental loops and casual abuse; not a substitute for App Check.
 */
export async function enforceRateLimit(orgId: string, key: string, limit: number, windowSeconds: number) {
  const ref = col(orgId, 'rateLimits').doc(key.replace(/[^A-Za-z0-9_-]/g, '_'));
  const now = Date.now();
  const allowed = await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    const start = snap.get('windowStart') as number | undefined;
    const count = (snap.get('count') as number | undefined) ?? 0;
    if (!start || now - start >= windowSeconds * 1000) {
      tx.set(ref, { windowStart: now, count: 1 });
      return true;
    }
    if (count >= limit) return false;
    tx.update(ref, { count: count + 1 });
    return true;
  });
  if (!allowed) throw new HttpsError('resource-exhausted', 'Too many requests. Please wait a minute and try again.', { code: 'RATE_LIMITED' });
}
