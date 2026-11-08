import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { deviceBindingApplies, isAttendanceAdmin, isSysAdmin } from '../../shared/roles';
import type { DeviceStatus, MemberDoc } from '../../shared/types';
import { audit, col, db, requireRole, type Caller } from './context';

/**
 * Registered-phone verification with WebAuthn passkeys.
 *
 * - Each employee registers their phone once; the phone keeps a private key
 *   that cannot be exported, and only the public key is stored here.
 * - Every clock-in signs a single-use server challenge, with user verification
 *   (the phone's own fingerprint/face/PIN) required. Biometrics never leave the
 *   phone; the server only verifies a signature.
 * - New or replacement phones need HR approval (the first phone can be
 *   auto-approved by setting). One active phone per employee.
 * - A random per-browser "device hint" is used only to detect one phone being
 *   used for several accounts (anomaly detection), never as proof of identity.
 */

export interface CallMeta {
  /** Browser Origin header of the callable request. */
  origin?: string;
}

const CHALLENGE_TTL_MS = 2 * 60_000;
const hintSchema = z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional();

function allowedOrigins(): string[] {
  return (process.env.WEBAUTHN_ORIGINS || '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** The relying party is derived from the request origin, which must be allow-listed. */
export function relyingParty(meta: CallMeta) {
  const origin = meta.origin;
  if (!origin || !allowedOrigins().includes(origin)) {
    throw new HttpsError('failed-precondition', `Phone registration is not configured for this app address (${origin ?? 'unknown'}). Ask your administrator to add it to WEBAUTHN_ORIGINS.`);
  }
  return { origin, rpID: new URL(origin).hostname };
}

const b64url = {
  encode: (u: Uint8Array) => Buffer.from(u).toString('base64url'),
  decode: (s: string) => new Uint8Array(Buffer.from(s, 'base64url')),
};

export interface StoredDevice {
  orgId: string;
  memberId: string;
  memberName: string;
  departmentId: string;
  credentialId: string;
  publicKey: string;
  counter: number;
  transports: AuthenticatorTransportFuture[];
  rpID: string;
  deviceHint: string | null;
  label: string;
  status: DeviceStatus;
  backedUp: boolean;
  deviceType: string;
  createdAt: number;
  approvedBy: string | null;
  approvedByName: string | null;
  approvedAt: number | null;
  lastUsedAt: number | null;
  revokedReason?: string | null;
}

async function devicesOf(orgId: string, memberId: string) {
  const snap = await col(orgId, 'devices').where('memberId', '==', memberId).get();
  return snap.docs.map((d) => ({ ...(d.data() as StoredDevice), id: d.id, ref: d.ref }));
}

export async function deviceSummary(caller: Caller) {
  const devices = await devicesOf(caller.orgId, caller.uid);
  const active = devices.find((d) => d.status === 'active');
  const pending = devices.find((d) => d.status === 'pending');
  return {
    required: deviceBindingApplies(caller.org.settings, caller.member),
    mode: caller.org.settings.deviceBinding.mode,
    status: active ? ('active' as const) : pending ? ('pending' as const) : ('none' as const),
    activeLabel: active?.label ?? null,
    pendingLabel: pending?.label ?? null,
  };
}

async function putChallenge(caller: Caller, purpose: 'register' | 'auth', challenge: string, rp: { origin: string; rpID: string }) {
  await col(caller.orgId, 'webauthnChallenges').doc(`${caller.uid}_${purpose}`).set({ challenge, purpose, ...rp, expiresAt: Date.now() + CHALLENGE_TTL_MS });
}

/** Reads and deletes the challenge atomically so it can be used only once. */
async function takeChallenge(caller: Caller, purpose: 'register' | 'auth') {
  const ref = col(caller.orgId, 'webauthnChallenges').doc(`${caller.uid}_${purpose}`);
  return db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) return null;
    tx.delete(ref);
    const c = snap.data() as { challenge: string; origin: string; rpID: string; expiresAt: number };
    return c.expiresAt >= Date.now() ? c : null;
  });
}

export async function registrationOptions(caller: Caller, _raw: unknown, meta: CallMeta) {
  const rp = relyingParty(meta);
  const devices = await devicesOf(caller.orgId, caller.uid);
  const options = await generateRegistrationOptions({
    rpName: 'ClockUp',
    rpID: rp.rpID,
    userID: new TextEncoder().encode(caller.uid),
    userName: caller.member.email,
    userDisplayName: caller.member.fullName,
    attestationType: 'none',
    timeout: 120_000,
    excludeCredentials: devices.filter((d) => d.status === 'active' || d.status === 'pending').map((d) => ({ id: d.credentialId, transports: d.transports })),
    authenticatorSelection: { authenticatorAttachment: 'platform', residentKey: 'preferred', userVerification: 'required' },
    supportedAlgorithmIDs: [-7, -257],
  });
  await putChallenge(caller, 'register', options.challenge, rp);
  return options;
}

const registerSchema = z.object({
  response: z.record(z.unknown()),
  deviceHint: hintSchema,
  label: z.string().trim().max(120).default('Phone'),
});

export async function registerDevice(caller: Caller, raw: unknown, _meta: CallMeta) {
  const input = registerSchema.parse(raw);
  const challenge = await takeChallenge(caller, 'register');
  if (!challenge) throw new HttpsError('failed-precondition', 'The registration expired. Please try again.');
  let verification;
  try {
    verification = await verifyRegistrationResponse({
      response: input.response as unknown as RegistrationResponseJSON,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      requireUserVerification: true,
    });
  } catch (e) {
    throw new HttpsError('invalid-argument', `Phone registration could not be verified: ${(e as Error).message}`);
  }
  if (!verification.verified) throw new HttpsError('invalid-argument', 'Phone registration could not be verified.');
  const info = verification.registrationInfo;
  const credentialId = info.credential.id;
  const ref = col(caller.orgId, 'devices').doc(credentialId);
  const settings = caller.org.settings.deviceBinding;

  const result = await db.runTransaction(async (tx) => {
    const [existing, mine, sameHint] = await Promise.all([
      tx.get(ref),
      tx.get(col(caller.orgId, 'devices').where('memberId', '==', caller.uid)),
      input.deviceHint ? tx.get(col(caller.orgId, 'devices').where('deviceHint', '==', input.deviceHint)) : Promise.resolve(null),
    ]);
    if (existing.exists) throw new HttpsError('already-exists', 'This passkey is already registered.');
    // One phone ↔ one employee: refuse a phone already registered to someone else.
    const taken = sameHint?.docs.find((d) => d.get('memberId') !== caller.uid && ['active', 'pending'].includes(d.get('status')));
    if (taken) throw new HttpsError('failed-precondition', 'This phone is already registered to another employee. Each phone can be registered to one employee only.');
    const hasActive = mine.docs.some((d) => d.get('status') === 'active');
    const status: DeviceStatus = !hasActive && settings.autoApproveFirstDevice ? 'active' : 'pending';
    // A new request replaces any earlier pending one from the same employee.
    for (const d of mine.docs) if (d.get('status') === 'pending') tx.update(d.ref, { status: 'superseded' });
    const now = Date.now();
    const doc: StoredDevice = {
      orgId: caller.orgId,
      memberId: caller.uid,
      memberName: caller.member.fullName,
      departmentId: caller.member.departmentId,
      credentialId,
      publicKey: b64url.encode(info.credential.publicKey),
      counter: info.credential.counter,
      transports: info.credential.transports ?? [],
      rpID: challenge.rpID,
      deviceHint: input.deviceHint ?? null,
      label: input.label || 'Phone',
      status,
      backedUp: info.credentialBackedUp,
      deviceType: info.credentialDeviceType,
      createdAt: now,
      approvedBy: status === 'active' ? 'auto-first-device' : null,
      approvedByName: status === 'active' ? 'Automatic (first phone)' : null,
      approvedAt: status === 'active' ? now : null,
      lastUsedAt: null,
    };
    tx.create(ref, doc);
    audit(tx, caller, { action: 'device.register', targetType: 'device', targetId: credentialId, after: { status, label: doc.label, backedUp: doc.backedUp } });
    return { id: credentialId, status };
  });
  return result;
}

export async function approveDevice(caller: Caller, raw: unknown) {
  requireRole(caller, ['hr', 'sysadmin'], 'approve phones');
  const { id } = z.object({ id: z.string().min(1).max(512) }).parse(raw);
  const ref = col(caller.orgId, 'devices').doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Phone registration not found.');
    const d = snap.data() as StoredDevice;
    if (d.memberId === caller.uid) throw new HttpsError('permission-denied', 'You cannot approve your own phone. Ask another administrator.');
    const target = await tx.get(col(caller.orgId, 'members').doc(d.memberId));
    if (isAttendanceAdmin(target.get('role')) && !isSysAdmin(caller.member.role)) throw new HttpsError('permission-denied', 'Only a system administrator can approve phones for administrators.');
    if (d.status !== 'pending') throw new HttpsError('failed-precondition', `This registration is ${d.status}.`);
    const others = await tx.get(col(caller.orgId, 'devices').where('memberId', '==', d.memberId));
    // One active phone per employee: approving a new phone retires the old one.
    for (const o of others.docs) if (o.id !== id && o.get('status') === 'active') tx.update(o.ref, { status: 'replaced', revokedReason: 'Replaced by a newly approved phone' });
    tx.update(ref, { status: 'active', approvedBy: caller.uid, approvedByName: caller.member.fullName, approvedAt: Date.now() });
    audit(tx, caller, { action: 'device.approve', targetType: 'device', targetId: id, before: { status: d.status }, after: { status: 'active', memberId: d.memberId } });
  });
  return { ok: true };
}

export async function revokeDevice(caller: Caller, raw: unknown) {
  const { id, reason } = z.object({ id: z.string().min(1).max(512), reason: z.string().trim().min(3).max(500) }).parse(raw);
  const ref = col(caller.orgId, 'devices').doc(id);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Phone registration not found.');
    const d = snap.data() as StoredDevice;
    const own = d.memberId === caller.uid;
    if (!own && !isAttendanceAdmin(caller.member.role)) throw new HttpsError('permission-denied', 'You cannot remove this phone.');
    if (!['active', 'pending'].includes(d.status)) throw new HttpsError('failed-precondition', `This registration is already ${d.status}.`);
    tx.update(ref, { status: 'revoked', revokedReason: reason, revokedBy: caller.uid, revokedAt: Date.now() });
    audit(tx, caller, { action: 'device.revoke', targetType: 'device', targetId: id, before: { status: d.status }, after: { status: 'revoked', memberId: d.memberId }, reason });
  });
  return { ok: true };
}

export async function setDeviceBindingRequired(caller: Caller, raw: unknown) {
  requireRole(caller, ['hr', 'sysadmin'], 'change phone requirements');
  const { uid, required } = z.object({ uid: z.string().min(1).max(128), required: z.boolean() }).parse(raw);
  const ref = col(caller.orgId, 'members').doc(uid);
  await db.runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new HttpsError('not-found', 'Employee not found.');
    const m = snap.data() as MemberDoc;
    if (isAttendanceAdmin(m.role) && !isSysAdmin(caller.member.role)) throw new HttpsError('permission-denied', 'Only a system administrator can change this for administrators.');
    tx.update(ref, { deviceBindingRequired: required });
    audit(tx, caller, { action: 'device.requirement', targetType: 'member', targetId: uid, before: { deviceBindingRequired: m.deviceBindingRequired ?? false }, after: { deviceBindingRequired: required } });
  });
  return { ok: true };
}

/** Clock-in step 1: a single-use challenge for the employee's active phone. */
export async function authenticationOptions(caller: Caller, _raw: unknown, meta: CallMeta) {
  const rp = relyingParty(meta);
  const active = (await devicesOf(caller.orgId, caller.uid)).filter((d) => d.status === 'active' && d.rpID === rp.rpID);
  if (!active.length) throw new HttpsError('failed-precondition', 'No registered phone for this app address. Register this phone first.', { code: 'DEVICE_NOT_REGISTERED' });
  const options = await generateAuthenticationOptions({
    rpID: rp.rpID,
    allowCredentials: active.map((d) => ({ id: d.credentialId, transports: d.transports })),
    userVerification: 'required',
    timeout: 120_000,
  });
  await putChallenge(caller, 'auth', options.challenge, rp);
  return options;
}

export type DeviceCheck =
  | { ok: true; required: boolean; credentialId: string | null }
  | { ok: false; code: 'DEVICE_NOT_REGISTERED' | 'DEVICE_PENDING_APPROVAL' | 'DEVICE_VERIFICATION_REQUIRED' | 'DEVICE_VERIFICATION_FAILED' };

/**
 * Clock-in step 2 (inside processClock): verifies the signed challenge against
 * the employee's active registered phone, with user verification required.
 */
export async function checkDevice(caller: Caller, assertion: unknown): Promise<DeviceCheck> {
  const required = deviceBindingApplies(caller.org.settings, caller.member);
  if (!required) return { ok: true, required: false, credentialId: null };
  const devices = await devicesOf(caller.orgId, caller.uid);
  const active = devices.filter((d) => d.status === 'active');
  if (!active.length) return { ok: false, code: devices.some((d) => d.status === 'pending') ? 'DEVICE_PENDING_APPROVAL' : 'DEVICE_NOT_REGISTERED' };
  if (!assertion || typeof assertion !== 'object') return { ok: false, code: 'DEVICE_VERIFICATION_REQUIRED' };
  const response = assertion as AuthenticationResponseJSON;
  const device = active.find((d) => d.credentialId === response.id);
  const challenge = await takeChallenge(caller, 'auth');
  if (!device || !challenge || device.rpID !== challenge.rpID) return { ok: false, code: 'DEVICE_VERIFICATION_FAILED' };
  try {
    const v = await verifyAuthenticationResponse({
      response,
      expectedChallenge: challenge.challenge,
      expectedOrigin: challenge.origin,
      expectedRPID: challenge.rpID,
      credential: { id: device.credentialId, publicKey: b64url.decode(device.publicKey), counter: device.counter, transports: device.transports },
      requireUserVerification: true,
    });
    if (!v.verified) return { ok: false, code: 'DEVICE_VERIFICATION_FAILED' };
    await device.ref.update({ counter: v.authenticationInfo.newCounter, lastUsedAt: Date.now() });
    return { ok: true, required: true, credentialId: device.credentialId };
  } catch {
    return { ok: false, code: 'DEVICE_VERIFICATION_FAILED' };
  }
}
