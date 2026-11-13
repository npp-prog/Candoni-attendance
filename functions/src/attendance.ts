import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import { determineNextAction, type NextActionResult, type Punches } from '../../shared/attendance';
import { LIMITS } from '../../shared/defaults';
import { REJECTION_MESSAGES, type RejectionCode } from '../../shared/errors';
import { evaluateGeofences, isValidLatLng, type GeofenceTarget } from '../../shared/geo';
import { localDate } from '../../shared/time';
import { ALL_ACTIONS, type AttendanceAction, type ShiftPlan } from '../../shared/types';
import { col, db, enforceRateLimit, loadCaller, type Caller } from './context';
import {
  activeFieldwork,
  authorizedWorkplaces,
  datesAround,
  fieldworkTargets,
  categoryOf,
  loadScheduleContext,
  planFor,
  shiftId,
  type ShiftDoc,
} from './data';
import { checkDevice, deviceSummary } from './device';

export const clockSchema = z.object({
  requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/),
  action: z.enum(ALL_ACTIONS as [AttendanceAction, ...AttendanceAction[]]),
  location: z
    .object({
      lat: z.number(),
      lng: z.number(),
      accuracy: z.number(),
      capturedAt: z.number().int(),
      /** Device clock when the request was sent; lets age be measured on one clock. */
      sentAt: z.number().int().optional(),
    })
    .nullable()
    .optional(),
  /** Random per-browser identifier, used only to detect phones shared between accounts. */
  deviceHint: z.string().regex(/^[A-Za-z0-9-]{8,64}$/).optional(),
  /** WebAuthn assertion from the registered phone (required when phone verification applies). */
  deviceAssertion: z.record(z.unknown()).nullable().optional(),
});
export type ClockInput = z.infer<typeof clockSchema>;

export interface ClockReceipt {
  ok: true;
  replayed: boolean;
  eventId: string;
  action: AttendanceAction;
  workDate: string;
  at: number;
  timezone: string;
  workplaceName: string;
  workplaceId: string;
  distanceMeters: number | null;
  accuracyMeters: number;
  validation: 'geofence' | 'fieldwork_location' | 'fieldwork_exemption' | 'wfh_location' | 'wfh_exemption';
  deviceVerified?: boolean;
}

export interface ClockRejection {
  ok: false;
  code: RejectionCode;
  message: string;
  details?: Record<string, unknown>;
}

class Rejection extends Error {
  constructor(
    public code: RejectionCode,
    public details?: Record<string, unknown>,
    message?: string,
  ) {
    super(message ?? REJECTION_MESSAGES[code]);
  }
}

const eventIdFor = (uid: string, requestId: string) => `${uid}_${requestId}`;

function receiptFromEvent(id: string, d: FirebaseFirestore.DocumentData, replayed: boolean): ClockReceipt {
  return {
    ok: true,
    replayed,
    eventId: id,
    action: d.action,
    workDate: d.workDate,
    at: d.at,
    timezone: d.timezone,
    workplaceName: d.workplaceName,
    workplaceId: d.workplaceId,
    distanceMeters: d.distanceMeters,
    accuracyMeters: d.accuracyMeters,
    validation: d.validation,
    deviceVerified: d.deviceVerified ?? false,
  };
}

/** Builds yesterday/today/tomorrow plans, preferring snapshots stored on shift docs. */
async function planContext(caller: Caller, now: number) {
  const tz = caller.org.settings.timezone;
  const dates = datesAround(localDate(now, tz));
  const sctx = await loadScheduleContext(caller.orgId, tz, dates.yesterday, dates.tomorrow, [caller.uid]);
  return { tz, dates, sctx };
}

/**
 * Work dates (among the given ones) with a pending or approved overtime request.
 * Overtime In is offered only for those dates; approval can come later.
 */
export async function overtimeRequestedFor(caller: Caller, dates: string[]): Promise<Record<string, boolean>> {
  const snap = await col(caller.orgId, 'correctionRequests').where('memberId', '==', caller.uid).where('type', '==', 'overtime').get();
  const out: Record<string, boolean> = {};
  for (const d of snap.docs) {
    if (dates.includes(d.get('workDate')) && ['pending', 'approved'].includes(d.get('status'))) out[d.get('workDate')] = true;
  }
  return out;
}

export function nextActionFrom(
  caller: Caller,
  now: number,
  plansIn: Record<'yesterday' | 'today' | 'tomorrow', ShiftPlan>,
  shifts: (ShiftDoc | null)[],
  overtimeRequested: Record<string, boolean> = {},
): NextActionResult {
  const s = caller.org.settings;
  const punches: Record<string, Punches> = {};
  const plans = { ...plansIn };
  (['yesterday', 'today', 'tomorrow'] as const).forEach((k, i) => {
    const shift = shifts[i];
    if (shift) {
      punches[shift.workDate] = shift.punches ?? {};
      plans[k] = shift.plan;
    }
  });
  return determineNextAction({
    now,
    plans,
    punches,
    allowUnscheduled: s.allowUnscheduledAttendance,
    unscheduledMaxHours: s.unscheduledMaxHours,
    minActionIntervalSeconds: s.minActionIntervalSeconds,
    overtimeRequested,
  });
}

/**
 * Trusted clock-in/out. Order of checks:
 *  1. authenticated, member, active (fresh read), privacy notice accepted
 *  2. idempotency: a replayed requestId returns the original receipt
 *  3. throttle
 *  4. location sanity: present, valid, accurate enough, fresh, not from the future
 *  5. in a transaction: schedule/shift resolution, next valid action, geofence, write
 * Rejected attempts are logged to attendanceAttempts (HR-only) for review.
 */
export async function processClock(uid: string | undefined, raw: unknown, nowFn: () => number = Date.now): Promise<ClockReceipt | ClockRejection> {
  const parsed = clockSchema.safeParse(raw);
  if (!parsed.success) return reject('INVALID_REQUEST');
  const input = parsed.data;

  let caller: Caller;
  try {
    caller = await loadCaller(uid, { allowInactive: true });
  } catch (e) {
    if (e instanceof HttpsError && e.code === 'unauthenticated') return reject('UNAUTHENTICATED');
    return reject('NOT_A_MEMBER');
  }
  const eventRef = col(caller.orgId, 'attendanceEvents').doc(eventIdFor(caller.uid, input.requestId));

  try {
    if (!caller.member.active) throw new Rejection('ACCOUNT_INACTIVE');

    // Idempotent replay: return the original result without re-validating.
    const existing = await eventRef.get();
    if (existing.exists) {
      if (existing.get('action') !== input.action) throw new Rejection('REQUEST_ID_REUSED');
      return receiptFromEvent(existing.id, existing.data()!, true);
    }

    const settings = caller.org.settings;
    if ((caller.member.privacyAcceptedVersion ?? 0) < settings.privacyNoticeVersion) throw new Rejection('PRIVACY_NOTICE_REQUIRED');

    try {
      await enforceRateLimit(caller.orgId, `clock_${caller.uid}`, 12, 300);
    } catch {
      throw new Rejection('RATE_LIMITED');
    }

    const loc = input.location;
    if (!loc) throw new Rejection('LOCATION_MISSING');
    if (!isValidLatLng(loc.lat, loc.lng) || !(loc.accuracy > 0) || !Number.isFinite(loc.accuracy)) throw new Rejection('LOCATION_INVALID');
    const now = nowFn();
    if (loc.accuracy > settings.maxAccuracyMeters) {
      throw new Rejection('LOCATION_INACCURATE', { accuracyMeters: Math.round(loc.accuracy), maxAccuracyMeters: settings.maxAccuracyMeters });
    }
    // Location age is measured on the device clock (sentAt - capturedAt) when
    // available, so a phone whose clock is off does not cause false "stale"
    // rejections. Without sentAt, the server clock is used.
    const reference = loc.sentAt ?? now;
    if (loc.capturedAt > reference + LIMITS.futureSkewSeconds * 1000) throw new Rejection('LOCATION_FROM_FUTURE');
    if (loc.sentAt != null && Math.abs(now - loc.sentAt) > 24 * 3_600_000) throw new Rejection('LOCATION_FROM_FUTURE');
    const ageSeconds = Math.max(0, (reference - loc.capturedAt) / 1000);
    if (ageSeconds > settings.maxLocationAgeSeconds) {
      throw new Rejection('LOCATION_STALE', { ageSeconds: Math.round(ageSeconds), maxLocationAgeSeconds: settings.maxLocationAgeSeconds });
    }

    const { tz, dates, sctx } = await planContext(caller, now);
    const basePlans = {
      yesterday: planFor(sctx, caller.uid, dates.yesterday),
      today: planFor(sctx, caller.uid, dates.today),
      tomorrow: planFor(sctx, caller.uid, dates.tomorrow),
    };
    const otRequested = await overtimeRequestedFor(caller, [dates.yesterday, dates.today, dates.tomorrow]);
    const [workplaces, fieldwork] = await Promise.all([authorizedWorkplaces(caller.orgId, caller.member), activeFieldwork(caller.orgId, caller.uid, now)]);

    // Geofence evaluation (outside the transaction: pure computation on loaded data).
    const targets: GeofenceTarget[] = [
      ...workplaces.map((w) => ({ id: w.id, name: w.name, lat: w.lat, lng: w.lng, radiusMeters: w.radiusMeters })),
      ...fieldworkTargets(fieldwork),
    ];
    const exemption = fieldwork.find((f) => f.mode === 'exemption');
    const { nearest, match } = evaluateGeofences(loc.lat, loc.lng, targets);
    let validation: ClockReceipt['validation'];
    let workplaceId: string;
    let workplaceName: string;
    let distanceMeters: number | null;
    if (match) {
      if (match.target.id.startsWith('fieldwork:')) {
        const auth = fieldwork.find((f) => `fieldwork:${f.id}` === match.target.id);
        validation = auth && categoryOf(auth) === 'wfh' ? 'wfh_location' : 'fieldwork_location';
      } else {
        validation = 'geofence';
      }
      workplaceId = match.target.id;
      workplaceName = match.target.name;
      distanceMeters = Math.round(match.distanceMeters * 10) / 10;
    } else if (exemption) {
      const wfh = categoryOf(exemption) === 'wfh';
      validation = wfh ? 'wfh_exemption' : 'fieldwork_exemption';
      workplaceId = `fieldwork:${exemption.id}`;
      workplaceName = `${wfh ? 'Work from home (exemption)' : 'Fieldwork exemption'}: ${exemption.purpose}`.slice(0, 120);
      distanceMeters = nearest ? Math.round(nearest.distanceMeters) : null;
    } else if (!targets.length) {
      throw new Rejection('NO_AUTHORIZED_WORKPLACE');
    } else {
      throw new Rejection(
        'OUTSIDE_GEOFENCE',
        {
          nearestWorkplace: nearest!.target.name,
          distanceMeters: Math.round(nearest!.distanceMeters),
          radiusMeters: nearest!.target.radiusMeters,
        },
        `You are about ${Math.round(nearest!.distanceMeters)} m from ${nearest!.target.name}; the allowed radius is ${nearest!.target.radiusMeters} m.`,
      );
    }

    // Registered-phone verification (passkey with the phone's own screen lock).
    const device = await checkDevice(caller, input.deviceAssertion);
    if (!device.ok) throw new Rejection(device.code);

    const shiftRefs = [dates.yesterday, dates.today, dates.tomorrow].map((d) => col(caller.orgId, 'shiftInstances').doc(shiftId(caller.uid, d)));

    // The transaction serializes concurrent submissions: shift documents act as
    // the lock and the event document id is derived from the idempotency key.
    const receipt = await db.runTransaction(async (tx) => {
      const [evSnap, memberSnap, ...shiftSnaps] = await Promise.all([
        tx.get(eventRef),
        tx.get(col(caller.orgId, 'members').doc(caller.uid)),
        ...shiftRefs.map((r) => tx.get(r)),
      ]);
      if (evSnap.exists) {
        if (evSnap.get('action') !== input.action) throw new Rejection('REQUEST_ID_REUSED');
        return receiptFromEvent(evSnap.id, evSnap.data()!, true);
      }
      if (!memberSnap.get('active')) throw new Rejection('ACCOUNT_INACTIVE');
      const official = nowFn();
      const shifts = shiftSnaps.map((s) => (s.exists ? (s.data() as ShiftDoc) : null));
      const next = nextActionFrom(caller, official, basePlans, shifts, otRequested);
      if (next.code !== 'OK') {
        throw new Rejection(next.code, next.availableAt ? { availableAt: next.availableAt } : undefined, next.message);
      }
      if (next.action !== input.action) {
        throw new Rejection('ACTION_NOT_ALLOWED', { expectedAction: next.action }, `The next valid action is ${next.action}. Refresh and try again.`);
      }
      const shiftIdx = [dates.yesterday, dates.today, dates.tomorrow].indexOf(next.workDate);
      const shiftRef = shiftRefs[shiftIdx];
      const existingShift = shifts[shiftIdx];
      const plan = existingShift?.plan ?? next.plan;

      const event = {
        orgId: caller.orgId,
        memberId: caller.uid,
        memberName: caller.member.fullName,
        employeeNumber: caller.member.employeeNumber,
        departmentId: caller.member.departmentId,
        shiftInstanceId: shiftRef.id,
        workDate: next.workDate,
        action: input.action,
        at: official,
        timezone: tz,
        requestId: input.requestId,
        outcome: 'accepted' as const,
        validation,
        workplaceId,
        workplaceName,
        distanceMeters,
        accuracyMeters: Math.round(loc.accuracy * 10) / 10,
        locationAgeSeconds: Math.round(ageSeconds * 10) / 10,
        deviceVerified: device.required,
        deviceCredentialId: device.credentialId,
        unscheduled: plan.unscheduled,
      };
      tx.create(eventRef, event);
      tx.create(col(caller.orgId, 'attendanceLocationEvidence').doc(eventRef.id), {
        orgId: caller.orgId,
        memberId: caller.uid,
        eventId: eventRef.id,
        workDate: next.workDate,
        lat: loc.lat,
        lng: loc.lng,
        accuracyMeters: loc.accuracy,
        capturedAt: loc.capturedAt,
        receivedAt: official,
        deviceSentAt: loc.sentAt ?? null,
        deviceHint: input.deviceHint ?? null,
        deviceVerified: device.required,
        deviceClockSkewSeconds: loc.sentAt != null ? Math.round((loc.sentAt - official) / 1000) : null,
        workplaceId,
        distanceMeters,
      });
      const shift: ShiftDoc = {
        orgId: caller.orgId,
        memberId: caller.uid,
        departmentId: existingShift?.departmentId ?? caller.member.departmentId,
        workDate: next.workDate,
        plan,
        punches: { ...(existingShift?.punches ?? {}), [input.action]: official },
        correctedActions: existingShift?.correctedActions ?? [],
        eventIds: { ...(existingShift?.eventIds ?? {}), [input.action]: eventRef.id },
        version: (existingShift?.version ?? 0) + 1,
        updatedAt: official,
      };
      tx.set(shiftRef, shift);
      return receiptFromEvent(eventRef.id, event, false);
    });
    return receipt;
  } catch (e) {
    if (e instanceof Rejection) {
      await logAttempt(caller, input, e).catch(() => undefined);
      return reject(e.code, e.details, e.message);
    }
    throw e;
  }
}

async function logAttempt(caller: Caller, input: ClockInput, e: Rejection) {
  if (e.code === 'RATE_LIMITED') return; // avoid amplifying abusive loops
  await col(caller.orgId, 'attendanceAttempts').add({
    orgId: caller.orgId,
    memberId: caller.uid,
    memberName: caller.member.fullName,
    departmentId: caller.member.departmentId,
    requestId: input.requestId,
    action: input.action,
    code: e.code,
    message: e.message,
    details: e.details ?? null,
    location: input.location ?? null,
    deviceHint: input.deviceHint ?? null,
    at: Date.now(),
  });
}

function reject(code: RejectionCode, details?: Record<string, unknown>, message?: string): ClockRejection {
  return { ok: false, code, message: message ?? REJECTION_MESSAGES[code], ...(details ? { details } : {}) };
}

/** Lets a client confirm whether a previously sent request was accepted. */
export async function attendanceRequestStatus(uid: string | undefined, raw: unknown) {
  const parsed = z.object({ requestId: z.string().regex(/^[A-Za-z0-9-]{8,64}$/) }).safeParse(raw);
  if (!parsed.success) throw new HttpsError('invalid-argument', 'Invalid request id.');
  const caller = await loadCaller(uid, { allowInactive: true });
  const snap = await col(caller.orgId, 'attendanceEvents').doc(eventIdFor(caller.uid, parsed.data.requestId)).get();
  if (snap.exists) return { found: true, receipt: receiptFromEvent(snap.id, snap.data()!, true) };
  return { found: false };
}

/** Employee home screen data: plan, punches, next valid action and authorized places. */
export async function myToday(caller: Caller, nowFn: () => number = Date.now) {
  const now = nowFn();
  const { tz, dates, sctx } = await planContext(caller, now);
  const basePlans = {
    yesterday: planFor(sctx, caller.uid, dates.yesterday),
    today: planFor(sctx, caller.uid, dates.today),
    tomorrow: planFor(sctx, caller.uid, dates.tomorrow),
  };
  const otRequested = await overtimeRequestedFor(caller, [dates.yesterday, dates.today, dates.tomorrow]);
  const shiftSnaps = await Promise.all(
    [dates.yesterday, dates.today, dates.tomorrow].map((d) => col(caller.orgId, 'shiftInstances').doc(shiftId(caller.uid, d)).get()),
  );
  const shifts = shiftSnaps.map((s) => (s.exists ? (s.data() as ShiftDoc) : null));
  const next = nextActionFrom(caller, now, basePlans, shifts, otRequested);
  const shift = shifts[[dates.yesterday, dates.today, dates.tomorrow].indexOf(next.workDate)];
  const [workplaces, fieldwork] = await Promise.all([authorizedWorkplaces(caller.orgId, caller.member), activeFieldwork(caller.orgId, caller.uid, now)]);
  return {
    serverTime: now,
    timezone: tz,
    today: dates.today,
    scheduleName: sctx.schedules.get(
      (sctx.assignmentsByMember.get(caller.uid) ?? []).find((a) => a.effectiveFrom <= dates.today && (!a.effectiveTo || a.effectiveTo >= dates.today))?.scheduleId ?? '',
    )?.name ?? null,
    next: {
      code: next.code,
      action: next.action,
      workDate: next.workDate,
      message: next.message,
      availableAt: next.availableAt ?? null,
    },
    plan: shift?.plan ?? next.plan,
    punches: shift?.punches ?? {},
    correctedActions: shift?.correctedActions ?? [],
    workplaces: workplaces.map((w) => ({ id: w.id, name: w.name, address: w.address, lat: w.lat, lng: w.lng, radiusMeters: w.radiusMeters })),
    fieldwork: fieldwork.map((f) => ({
      id: f.id,
      category: categoryOf(f),
      mode: f.mode,
      purpose: f.purpose,
      startAt: f.startAt,
      endAt: f.endAt,
      locationName: f.locationName ?? null,
      lat: f.lat ?? null,
      lng: f.lng ?? null,
      radiusMeters: f.radiusMeters ?? null,
    })),
    wfhEnabled: caller.org.settings.wfhEnabled,
    device: await deviceSummary(caller),
    limits: { maxAccuracyMeters: caller.org.settings.maxAccuracyMeters, maxLocationAgeSeconds: caller.org.settings.maxLocationAgeSeconds },
  };
}
