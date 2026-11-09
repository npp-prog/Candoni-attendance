import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/api';
import { processClock } from '../src/attendance';
import { col, orgRef } from '../src/context';
import { at, BASE, clearRateLimits, loc, rid, seedOrg, type Fixture } from './helpers';
import { SoftAuthenticator } from './softAuthenticator';

const ORIGIN = 'https://clockup.example.test';
process.env.WEBAUTHN_ORIGINS = `${ORIGIN},https://other.example.test`;
const meta = { origin: ORIGIN };

let f: Fixture;
const api = (who: string, op: string, data: unknown = {}, m = meta) => handleApi(f.uid(who), { op, data }, m);

async function register(who: string, auth: SoftAuthenticator, hint = `hint-${who}-0001`) {
  const options = (await api(who, 'device.registerOptions')) as { challenge: string };
  return (await api(who, 'device.register', { response: auth.register(options.challenge), deviceHint: hint, label: `${who} phone` })) as { id: string; status: string };
}
async function clockWith(who: string, auth: SoftAuthenticator | null, now: number, opts: { uv?: boolean; reuse?: unknown } = {}) {
  let assertion: unknown = null;
  if (auth) {
    const o = (await api(who, 'device.authOptions')) as { challenge: string };
    assertion = opts.reuse ?? auth.assert(o.challenge, opts);
  }
  return { result: await processClock(f.uid(who), { requestId: rid(), action: 'IN', location: loc(BASE, now), deviceHint: `hint-${who}-0001`, deviceAssertion: assertion }, () => now), assertion };
}

beforeAll(async () => {
  f = await seedOrg(`dev${Date.now().toString(36)}`);
  await orgRef(f.orgId).update({ 'settings.deviceBinding': { mode: 'selected', autoApproveFirstDevice: true } });
});
beforeEach(async () => clearRateLimits(f.orgId));

describe('registered phone requirement', () => {
  it('does not apply to employees outside the pilot', async () => {
    const now = at('2026-03-02', '08:00');
    expect((await processClock(f.uid('emp3'), { requestId: rid(), action: 'IN', location: loc({ lat: BASE.lat + 0.05, lng: BASE.lng }, now) }, () => now)).ok).toBe(true);
  });

  it('blocks a flagged employee without a registered phone, then auto-approves the first phone', async () => {
    await api('hr', 'employee.setDeviceBinding', { uid: f.uid('emp1'), required: true });
    const now = at('2026-03-03', '08:00');
    expect((await clockWith('emp1', null, now)).result).toMatchObject({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
    const phone = new SoftAuthenticator(ORIGIN);
    expect(await register('emp1', phone)).toMatchObject({ status: 'active' });
    expect((await clockWith('emp1', null, now)).result).toMatchObject({ ok: false, code: 'DEVICE_VERIFICATION_REQUIRED' });
    const { result, assertion } = await clockWith('emp1', phone, now);
    expect(result).toMatchObject({ ok: true, deviceVerified: true });
    // The signed challenge is single-use: replaying it fails.
    const now2 = at('2026-03-04', '08:00');
    expect((await clockWith('emp1', phone, now2, { reuse: assertion })).result).toMatchObject({ ok: false, code: 'DEVICE_VERIFICATION_FAILED' });
    // The phone's own screen lock (user verification) is required.
    expect((await clockWith('emp1', phone, now2, { uv: false })).result).toMatchObject({ ok: false, code: 'DEVICE_VERIFICATION_FAILED' });
    const ev = await col(f.orgId, 'attendanceEvents').where('memberId', '==', f.uid('emp1')).get();
    expect(ev.docs.find((d) => d.get('workDate') === '2026-03-03')?.get('deviceVerified')).toBe(true);
  });

  it('rejects clocking in for a coworker from a different phone', async () => {
    const coworkerPhone = new SoftAuthenticator(ORIGIN);
    // emp1's account, but the passkey on the coworker's phone is not emp1's registered credential.
    const o = (await api('emp1', 'device.authOptions')) as { challenge: string };
    const now = at('2026-03-05', '08:00');
    const r = await processClock(f.uid('emp1'), { requestId: rid(), action: 'IN', location: loc(BASE, now), deviceAssertion: coworkerPhone.assert(o.challenge) }, () => now);
    expect(r).toMatchObject({ ok: false, code: 'DEVICE_VERIFICATION_FAILED' });
  });

  it('refuses to register a phone already registered to another employee', async () => {
    await api('hr', 'employee.setDeviceBinding', { uid: f.uid('emp2'), required: true });
    // emp2 tries to register on emp1's phone (same browser hint).
    await expect(register('emp2', new SoftAuthenticator(ORIGIN), 'hint-emp1-0001')).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(await register('emp2', new SoftAuthenticator(ORIGIN))).toMatchObject({ status: 'active' });
  });

  it('requires HR approval for a replacement phone and retires the old one', async () => {
    const newPhone = new SoftAuthenticator(ORIGIN);
    const reg = await register('emp1', newPhone, 'hint-emp1-0002');
    expect(reg.status).toBe('pending');
    const now = at('2026-03-06', '08:00');
    // Still clocks with the old phone until approval; the new phone is refused.
    expect((await clockWith('emp1', newPhone, now)).result).toMatchObject({ ok: false, code: 'DEVICE_VERIFICATION_FAILED' });
    await expect(api('emp1', 'device.approve', { id: reg.id })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('sup1', 'device.approve', { id: reg.id })).rejects.toMatchObject({ code: 'permission-denied' });
    await api('hr', 'device.approve', { id: reg.id });
    const devices = await col(f.orgId, 'devices').where('memberId', '==', f.uid('emp1')).get();
    expect(devices.docs.filter((d) => d.get('status') === 'active').map((d) => d.id)).toEqual([reg.id]);
    expect(devices.docs.some((d) => d.get('status') === 'replaced')).toBe(true);
    expect((await clockWith('emp1', newPhone, now)).result).toMatchObject({ ok: true });
    const logs = await col(f.orgId, 'auditLogs').where('action', '==', 'device.approve').get();
    expect(logs.size).toBeGreaterThan(0);
  });

  it('applies to everyone in "all" mode and rejects unknown app origins', async () => {
    await orgRef(f.orgId).update({ 'settings.deviceBinding.mode': 'all' });
    const now = at('2026-03-09', '08:00');
    const yard = { lat: BASE.lat + 0.05, lng: BASE.lng }; // emp3 works at the Ops Yard
    const r = await processClock(f.uid('emp3'), { requestId: rid(), action: 'IN', location: loc(yard, now) }, () => now);
    expect(r).toMatchObject({ ok: false, code: 'DEVICE_NOT_REGISTERED' });
    await expect(api('emp3', 'device.registerOptions', {}, { origin: 'https://evil.example.test' })).rejects.toMatchObject({ code: 'failed-precondition' });
    await orgRef(f.orgId).update({ 'settings.deviceBinding.mode': 'selected' });
  });
});

describe('suspicious-activity report', () => {
  it('flags one phone used for several employees, HR only', async () => {
    const now = at('2026-03-10', '08:00');
    const shared = 'hint-shared-phone-01';
    await processClock(f.uid('emp3'), { requestId: rid(), action: 'IN', location: loc({ lat: BASE.lat + 0.05, lng: BASE.lng }, now), deviceHint: shared }, () => now);
    const second = await processClock(f.uid('hr2'), { requestId: rid(), action: 'IN', location: loc({ lat: BASE.lat + 0.05, lng: BASE.lng }, now + 120_000), deviceHint: shared }, () => now + 120_000);
    expect(second.ok).toBe(true);
    const r = (await api('hr', 'report.run', { type: 'device_anomalies', from: '2026-03-10', to: '2026-03-10' })) as { rows: { kind: string; employees: string[] }[] };
    expect(r.rows.map((x) => x.kind)).toEqual(expect.arrayContaining(['shared_phone', 'rapid_multi_account']));
    await expect(api('sup1', 'report.run', { type: 'device_anomalies', from: '2026-03-10', to: '2026-03-10' })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});
