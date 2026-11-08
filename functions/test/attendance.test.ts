import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { processClock, attendanceRequestStatus, myToday } from '../src/attendance';
import { col, loadCaller } from '../src/context';
import { at, BASE, clearRateLimits, loc, north, rid, seedOrg, type Fixture } from './helpers';

let f: Fixture;

beforeAll(async () => {
  f = await seedOrg(`att${Date.now().toString(36)}`);
});
beforeEach(async () => clearRateLimits(f.orgId));

const clock = (who: string, action: string, now: number, location: unknown, requestId = rid()) =>
  processClock(f.uid(who), { requestId, action, location }, () => now);

async function eventsFor(who: string) {
  const s = await col(f.orgId, 'attendanceEvents').where('memberId', '==', f.uid(who)).get();
  return s.docs.map((d) => d.data());
}

describe('clockAttendance geofence and location validation', () => {
  it('accepts a clock-in inside the geofence and stores event, evidence and shift', async () => {
    const now = at('2026-02-02', '07:55');
    const r = await clock('emp2', 'IN', now, loc(north(40), now));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.workDate).toBe('2026-02-02');
    expect(r.workplaceId).toBe('w1');
    expect(r.distanceMeters).toBeCloseTo(40, 0);
    expect(r.at).toBe(now);
    const ev = await col(f.orgId, 'attendanceEvents').doc(r.eventId).get();
    expect(ev.get('outcome')).toBe('accepted');
    expect(ev.get('lat')).toBeUndefined(); // coordinates live only in evidence
    const evidence = await col(f.orgId, 'attendanceLocationEvidence').doc(r.eventId).get();
    expect(evidence.get('lat')).toBeCloseTo(north(40).lat, 8);
    const shift = await col(f.orgId, 'shiftInstances').doc(`${f.uid('emp2')}_2026-02-02`).get();
    expect(shift.get('punches.IN')).toBe(now);
  });

  it('rejects a location outside the geofence with distance details and logs the attempt', async () => {
    const now = at('2026-02-03', '07:55');
    const r = await clock('emp2', 'IN', now, loc(north(150), now));
    expect(r).toMatchObject({ ok: false, code: 'OUTSIDE_GEOFENCE' });
    if (r.ok) return;
    expect(r.details?.distanceMeters).toBe(150);
    expect(r.details?.radiusMeters).toBe(100);
    const attempts = await col(f.orgId, 'attendanceAttempts').where('memberId', '==', f.uid('emp2')).where('code', '==', 'OUTSIDE_GEOFENCE').get();
    expect(attempts.size).toBeGreaterThan(0);
  });

  it('handles the geofence boundary precisely', async () => {
    const now = at('2026-02-04', '07:55');
    expect((await clock('emp2', 'IN', now, loc(north(100.6), now))).ok).toBe(false);
    expect((await clock('emp2', 'IN', now, loc(north(99.4), now))).ok).toBe(true);
  });

  it('rejects poor accuracy without enlarging the radius', async () => {
    const now = at('2026-02-05', '07:55');
    const r = await clock('emp2', 'IN', now, loc(BASE, now, 101));
    expect(r).toMatchObject({ ok: false, code: 'LOCATION_INACCURATE' });
    // Outside by 20 m with accuracy 80 m is still rejected (no accuracy-based enlargement).
    const r2 = await clock('emp2', 'IN', now, loc(north(120), now, 80));
    expect(r2).toMatchObject({ ok: false, code: 'OUTSIDE_GEOFENCE' });
    // Exactly at the configured maximum is accepted.
    expect((await clock('emp2', 'IN', now, loc(BASE, now, 100))).ok).toBe(true);
  });

  it('rejects stale and future-dated readings', async () => {
    const now = at('2026-02-06', '07:55');
    expect(await clock('emp2', 'IN', now, loc(BASE, now, 10, 61_000))).toMatchObject({ ok: false, code: 'LOCATION_STALE' });
    expect(await clock('emp2', 'IN', now, loc(BASE, now, 10, -10 * 60_000))).toMatchObject({ ok: false, code: 'LOCATION_FROM_FUTURE' });
    expect(await clock('emp2', 'IN', now, null)).toMatchObject({ ok: false, code: 'LOCATION_MISSING' });
    expect(await clock('emp2', 'IN', now, { lat: 200, lng: 0, accuracy: 5, capturedAt: now })).toMatchObject({ ok: false, code: 'LOCATION_INVALID' });
  });

  it('measures location age on the device clock so a skewed phone clock is tolerated', async () => {
    const now = at('2026-02-06', '07:56');
    const skew = -7 * 60_000; // phone clock 7 minutes slow
    const r = await clock('emp2', 'IN', now, { lat: BASE.lat, lng: BASE.lng, accuracy: 10, capturedAt: now + skew - 3000, sentAt: now + skew });
    expect(r.ok).toBe(true);
    // A genuinely old reading is still stale on the device's own clock.
    const r2 = await clock('emp1', 'IN', now, { lat: BASE.lat, lng: BASE.lng, accuracy: 10, capturedAt: now + skew - 90_000, sentAt: now + skew });
    expect(r2).toMatchObject({ ok: false, code: 'LOCATION_STALE' });
  });

  it('rejects employees without an authorized workplace', async () => {
    const now = at('2026-02-06', '07:55');
    expect(await clock('noplace', 'IN', now, loc(BASE, now))).toMatchObject({ ok: false, code: 'NO_AUTHORIZED_WORKPLACE' });
  });

  it('rejects malformed requests', async () => {
    const r = await processClock(f.uid('emp1'), { requestId: 'x', action: 'IN' });
    expect(r).toMatchObject({ ok: false, code: 'INVALID_REQUEST' });
    expect(await processClock(undefined, { requestId: rid(), action: 'IN', location: null })).toMatchObject({ ok: false, code: 'UNAUTHENTICATED' });
  });
});

describe('sequencing, idempotency and concurrency', () => {
  it('rejects an invalid sequence (clock-out before clock-in)', async () => {
    const now = at('2026-02-09', '08:00');
    const r = await clock('emp1', 'OUT', now, loc(BASE, now));
    expect(r).toMatchObject({ ok: false, code: 'ACTION_NOT_ALLOWED', details: { expectedAction: 'IN' } });
  });

  it('rejects a second clock-in and a too-soon clock-out', async () => {
    const now = at('2026-02-10', '08:00');
    expect((await clock('emp1', 'IN', now, loc(BASE, now))).ok).toBe(true);
    expect(await clock('emp1', 'IN', now + 120_000, loc(BASE, now + 120_000))).toMatchObject({ ok: false, code: 'ACTION_NOT_ALLOWED' });
    expect(await clock('emp1', 'OUT', now + 10_000, loc(BASE, now + 10_000))).toMatchObject({ ok: false, code: 'TOO_SOON' });
    const out = at('2026-02-10', '17:05');
    expect(await clock('emp1', 'OUT', out, loc(BASE, out))).toMatchObject({ ok: true, action: 'OUT' });
    expect(await clock('emp1', 'OUT', out + 120_000, loc(BASE, out + 120_000))).toMatchObject({ ok: false, code: 'SHIFT_COMPLETE' });
  });

  it('returns the original receipt when the same request is retried', async () => {
    const now = at('2026-02-11', '08:00');
    const id = rid();
    const first = await clock('emp1', 'IN', now, loc(BASE, now), id);
    // A retry minutes later with a stale reading still returns the original receipt.
    const retry = await clock('emp1', 'IN', now + 300_000, loc(BASE, now, 10, 300_000), id);
    expect(first.ok && retry.ok).toBe(true);
    if (!first.ok || !retry.ok) return;
    expect(retry.replayed).toBe(true);
    expect(retry.eventId).toBe(first.eventId);
    expect(retry.at).toBe(first.at);
    const status = await attendanceRequestStatus(f.uid('emp1'), { requestId: id });
    expect(status.found).toBe(true);
    expect((await attendanceRequestStatus(f.uid('emp1'), { requestId: rid() })).found).toBe(false);
    const evs = (await eventsFor('emp1')).filter((e) => e.workDate === '2026-02-11');
    expect(evs).toHaveLength(1);
    expect(await clock('emp1', 'OUT', now + 400_000, loc(BASE, now + 400_000), id)).toMatchObject({ ok: false, code: 'REQUEST_ID_REUSED' });
  });

  it('accepts exactly one of several concurrent clock-ins with different request ids', async () => {
    const now = at('2026-02-12', '08:00');
    const results = await Promise.all(Array.from({ length: 5 }, () => clock('emp1', 'IN', now, loc(BASE, now))));
    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const evs = (await eventsFor('emp1')).filter((e) => e.workDate === '2026-02-12');
    expect(evs).toHaveLength(1);
  });

  it('creates one event for concurrent retries of the same request id', async () => {
    const now = at('2026-02-13', '08:00');
    const id = rid();
    const results = await Promise.all(Array.from({ length: 4 }, () => clock('emp1', 'IN', now, loc(BASE, now), id)));
    expect(results.every((r) => r.ok)).toBe(true);
    expect(new Set(results.map((r) => (r.ok ? r.eventId : ''))).size).toBe(1);
    const evs = (await eventsFor('emp1')).filter((e) => e.workDate === '2026-02-13');
    expect(evs).toHaveLength(1);
  });
});

describe('overnight shifts', () => {
  it('assigns an after-midnight clock-out to the shift start date', async () => {
    const tin = at('2026-02-16', '21:50');
    const r1 = await clock('nightemp', 'IN', tin, loc(BASE, tin));
    expect(r1).toMatchObject({ ok: true, workDate: '2026-02-16' });
    const tout = at('2026-02-16', '06:02', 1);
    const r2 = await clock('nightemp', 'OUT', tout, loc(BASE, tout));
    expect(r2).toMatchObject({ ok: true, action: 'OUT', workDate: '2026-02-16' });
    const caller = await loadCaller(f.uid('nightemp'));
    const today = await myToday(caller, () => tout + 3_600_000);
    expect(today.next.code).toBe('TOO_EARLY');
  });
});

describe('account status and privacy', () => {
  it('blocks inactive employees even with an existing session', async () => {
    await col(f.orgId, 'members').doc(f.uid('emp3')).update({ active: false });
    const now = at('2026-02-17', '08:00');
    expect(await clock('emp3', 'IN', now, loc(BASE, now))).toMatchObject({ ok: false, code: 'ACCOUNT_INACTIVE' });
    await col(f.orgId, 'members').doc(f.uid('emp3')).update({ active: true });
  });
  it('requires the privacy notice to be accepted', async () => {
    await col(f.orgId, 'members').doc(f.uid('emp3')).update({ privacyAcceptedVersion: null });
    const now = at('2026-02-17', '08:00');
    expect(await clock('emp3', 'IN', now, loc(BASE, now))).toMatchObject({ ok: false, code: 'PRIVACY_NOTICE_REQUIRED' });
    await col(f.orgId, 'members').doc(f.uid('emp3')).update({ privacyAcceptedVersion: 1 });
  });
  it('throttles rapid repeated attempts', async () => {
    const now = at('2026-02-18', '08:00');
    const results = [];
    for (let i = 0; i < 14; i++) results.push(await clock('emp3', 'IN', now, loc(north(5000), now)));
    expect(results.some((r) => !r.ok && r.code === 'RATE_LIMITED')).toBe(true);
  });
});

describe('fieldwork authorization', () => {
  it('accepts outside the office only within an approved exemption window', async () => {
    const now = at('2026-02-19', '08:00');
    const far = north(3000);
    expect(await clock('emp2', 'IN', now, loc(far, now))).toMatchObject({ ok: false, code: 'OUTSIDE_GEOFENCE' });
    await col(f.orgId, 'fieldworkAuthorizations').add({
      memberId: f.uid('emp2'), departmentId: 'd1', active: true, requestId: 'x', mode: 'exemption', purpose: 'Client visit',
      startAt: at('2026-02-19', '07:00'), endAt: at('2026-02-19', '18:00'),
    });
    expect(await clock('emp2', 'IN', now, loc(far, now))).toMatchObject({ ok: true, validation: 'fieldwork_exemption' });
  });
  it('accepts at an approved alternate location', async () => {
    const site = north(2000);
    await col(f.orgId, 'fieldworkAuthorizations').add({
      memberId: f.uid('emp2'), departmentId: 'd1', active: true, requestId: 'y', mode: 'alternate_location', purpose: 'Audit',
      locationName: 'Client HQ', lat: site.lat, lng: site.lng, radiusMeters: 150,
      startAt: at('2026-02-20', '07:00'), endAt: at('2026-02-20', '18:00'),
    });
    const now = at('2026-02-20', '08:00');
    expect(await clock('emp2', 'IN', now, loc(north(2100), now))).toMatchObject({ ok: true, validation: 'fieldwork_location', workplaceName: 'Client HQ' });
  });
});

describe('organization isolation', () => {
  it('does not let a member of another organization use this organization’s workplaces', async () => {
    const other = await seedOrg(`iso${Date.now().toString(36)}`);
    await col(other.orgId, 'workplaces').doc('w1').update({ active: false });
    const now = at('2026-02-23', '08:00');
    const r = await processClock(other.uid('emp1'), { requestId: rid(), action: 'IN', location: loc(BASE, now) }, () => now);
    expect(r).toMatchObject({ ok: false, code: 'NO_AUTHORIZED_WORKPLACE' });
    const evs = await col(f.orgId, 'attendanceEvents').where('memberId', '==', other.uid('emp1')).get();
    expect(evs.size).toBe(0);
  });
});
