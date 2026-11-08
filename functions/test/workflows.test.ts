import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { handleApi } from '../src/api';
import { processClock } from '../src/attendance';
import { col, orgRef } from '../src/context';
import { localDate } from '../../shared/time';
import { addDays } from '../../shared/time';
import { at, BASE, clearRateLimits, loc, rid, seedOrg, TZ, type Fixture } from './helpers';

let f: Fixture;
const api = (who: string, op: string, data: unknown) => handleApi(f.uid(who), { op, data });
const yesterday = addDays(localDate(Date.now(), TZ), -1);

beforeAll(async () => {
  f = await seedOrg(`wf${Date.now().toString(36)}`);
});
beforeEach(async () => clearRateLimits(f.orgId));

async function missingPunch(who: string, action = 'OUT', date = yesterday) {
  return (await api(who, 'request.submit', {
    type: 'missing_punch', workDate: date, action, proposedAt: `${date}T17:00`, explanation: 'Phone battery died at the end of the day.',
  })) as { id: string };
}

describe('role enforcement on the backend', () => {
  it('rejects administrative operations from employees and supervisors', async () => {
    await expect(api('emp1', 'department.upsert', { name: 'Hack' })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('emp1', 'employee.setRole', { uid: f.uid('emp1'), role: 'sysadmin' })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('sup1', 'workplace.upsert', { name: 'X', lat: 1, lng: 1, radiusMeters: 50 })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('hr', 'employee.setRole', { uid: f.uid('emp1'), role: 'hr' })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('hr', 'settings.update', {})).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('rejects unauthenticated and unknown operations', async () => {
    await expect(handleApi(undefined, { op: 'me.today' })).rejects.toMatchObject({ code: 'unauthenticated' });
    await expect(api('emp1', 'nope', {})).rejects.toMatchObject({ code: 'invalid-argument' });
  });
  it('lets a system administrator change roles but never remove the last one or self-promote', async () => {
    await api('admin', 'employee.setRole', { uid: f.uid('emp2'), role: 'supervisor', supervisedDepartmentIds: ['d1'] });
    expect((await col(f.orgId, 'members').doc(f.uid('emp2')).get()).get('role')).toBe('supervisor');
    await api('admin', 'employee.setRole', { uid: f.uid('emp2'), role: 'employee' });
    await expect(api('admin', 'employee.setRole', { uid: f.uid('admin'), role: 'employee' })).rejects.toMatchObject({ code: 'permission-denied' });
    const logs = await col(f.orgId, 'auditLogs').where('action', '==', 'role.change').where('targetId', '==', f.uid('emp2')).get();
    expect(logs.size).toBe(2);
  });
  it('prevents HR from changing their own assignments or other administrators', async () => {
    const profile = { employeeNumber: 'x1', fullName: 'HR Self', email: `${f.uid('hr')}@example.test`, departmentId: 'd1', position: 'HR', classification: 'Regular', supervisorUid: null, workplaceIds: ['w2'] };
    await expect(api('hr', 'employee.update', { ...profile, uid: f.uid('hr') })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('hr', 'employee.update', { ...profile, uid: f.uid('hr2') })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('employee lifecycle', () => {
  it('creates an employee with an Auth account, org link and setup link; deactivation blocks attendance', async () => {
    const res = (await api('hr', 'employee.create', {
      employeeNumber: `N-${Date.now()}`, fullName: 'New Hire', email: `new${Date.now()}@example.test`, departmentId: 'd1',
      position: 'Clerk', classification: 'Probationary', supervisorUid: f.uid('sup1'), workplaceIds: [],
    })) as { uid: string; resetLink: string };
    expect(res.uid).toBeTruthy();
    expect(res.resetLink).toMatch(/oobCode|mode=resetPassword/);
    await expect(api('hr', 'employee.create', { employeeNumber: 'E2', fullName: 'Boss', email: 'boss@example.test', departmentId: 'd1', position: '', classification: '', supervisorUid: null, role: 'sysadmin' })).rejects.toMatchObject({ code: 'permission-denied' });

    await col(f.orgId, 'members').doc(res.uid).update({ privacyAcceptedVersion: 1 });
    await api('hr', 'employee.setActive', { uid: res.uid, active: false, reason: 'Resigned' });
    const now = Date.now();
    const r = await processClock(res.uid, { requestId: rid(), action: 'IN', location: loc(BASE, now) });
    expect(r).toMatchObject({ ok: false, code: 'ACCOUNT_INACTIVE' });
    await expect(handleApi(res.uid, { op: 'me.today' })).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

describe('correction workflow', () => {
  it('prevents self-approval, even for HR', async () => {
    const { id } = await missingPunch('hr');
    await expect(api('hr', 'request.review', { id, decision: 'approve' })).rejects.toMatchObject({ code: 'permission-denied' });
  });

  it('limits supervisors to their departments', async () => {
    const { id } = await missingPunch('emp3', 'IN');
    await expect(api('sup1', 'request.review', { id, decision: 'approve' })).rejects.toMatchObject({ code: 'permission-denied' });
    await api('sup2', 'request.review', { id, decision: 'reject', remarks: 'Please attach proof.' });
    expect((await col(f.orgId, 'correctionRequests').doc(id).get()).get('status')).toBe('rejected');
  });

  it('rejects duplicate pending requests and duplicate processing', async () => {
    const { id } = await missingPunch('emp2', 'IN');
    await expect(missingPunch('emp2', 'IN')).rejects.toMatchObject({ code: 'already-exists' });
    const results = await Promise.allSettled([
      api('sup1', 'request.review', { id, decision: 'approve' }),
      api('hr', 'request.review', { id, decision: 'approve' }),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const adj = await col(f.orgId, 'adjustments').where('requestId', '==', id).get();
    expect(adj.size).toBe(1);
    await expect(api('hr', 'request.review', { id, decision: 'reject', remarks: 'late' })).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  it('keeps the original event and records an adjustment with before/after, reviewer and audit trail', async () => {
    const date = '2026-02-02';
    const tIn = at(date, '08:00');
    const r = await processClock(f.uid('emp1'), { requestId: rid(), action: 'IN', location: loc(BASE, tIn) }, () => tIn);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // HR corrects the clock-in time directly (authorized adjustment).
    const newIn = at(date, '07:45');
    const { adjustmentId } = (await api('hr', 'adjustment.create', { memberId: f.uid('emp1'), workDate: date, action: 'IN', at: newIn, reason: 'Gate log shows 07:45 arrival' })) as { adjustmentId: string };
    const adj = (await col(f.orgId, 'adjustments').doc(adjustmentId).get()).data()!;
    expect(adj).toMatchObject({ before: tIn, after: newIn, originalEventId: r.eventId, reviewerUid: f.uid('hr'), reason: 'Gate log shows 07:45 arrival' });
    const original = await col(f.orgId, 'attendanceEvents').doc(r.eventId).get();
    expect(original.get('at')).toBe(tIn);
    const shift = await col(f.orgId, 'shiftInstances').doc(`${f.uid('emp1')}_${date}`).get();
    expect(shift.get('punches.IN')).toBe(newIn);
    expect(shift.get('correctedActions')).toEqual(['IN']);
    const audit = await col(f.orgId, 'auditLogs').where('targetId', '==', adjustmentId).get();
    expect(audit.docs[0].get('action')).toBe('attendance.adjust');
    // HR cannot adjust their own attendance.
    await expect(api('hr', 'adjustment.create', { memberId: f.uid('hr'), workDate: date, action: 'IN', at: newIn, reason: 'Self fix attempt' })).rejects.toMatchObject({ code: 'permission-denied' });
    // Out-of-order adjustments are refused.
    await expect(api('hr', 'adjustment.create', { memberId: f.uid('emp1'), workDate: date, action: 'OUT', at: at(date, '07:00'), reason: 'Wrong order test' })).rejects.toMatchObject({ code: 'failed-precondition' });
    // Rebuilding summaries from sources detects no drift.
    const rebuilt = (await api('hr', 'summaries.rebuild', { from: date, to: date })) as { changed: number };
    expect(rebuilt.changed).toBe(0);
    // Report flags corrected records.
    const report = (await api('hr', 'report.run', { type: 'daily', from: date, to: date, memberId: f.uid('emp1') })) as { rows: { exceptions: string[] }[] };
    expect(report.rows[0].exceptions).toContain('CORRECTED');
  });

  it('honours hr_only approval mode', async () => {
    const snap = await orgRef(f.orgId).get();
    await orgRef(f.orgId).update({ 'settings.approvalMode': 'hr_only' });
    const { id } = await missingPunch('emp1', 'OUT');
    await expect(api('sup1', 'request.review', { id, decision: 'approve' })).rejects.toMatchObject({ code: 'permission-denied' });
    await orgRef(f.orgId).update({ 'settings.approvalMode': snap.get('settings.approvalMode') });
  });

  it('turns an approved fieldwork request into an authorization', async () => {
    const d = localDate(Date.now(), TZ);
    const { id } = (await api('emp2', 'request.submit', {
      type: 'fieldwork', workDate: d, explanation: 'Audit at client site.',
      fieldwork: { startAt: `${d}T07:00`, endAt: `${d}T18:00`, mode: 'exemption', purpose: 'Client audit' },
    })) as { id: string };
    const res = (await api('sup1', 'request.review', { id, decision: 'approve', remarks: 'OK' })) as { fieldworkAuthorizationId: string };
    const fw = await col(f.orgId, 'fieldworkAuthorizations').doc(res.fieldworkAuthorizationId).get();
    expect(fw.get('active')).toBe(true);
    expect(fw.get('approvedBy')).toBe(f.uid('sup1'));
  });
});

describe('reports and monitoring scope', () => {
  it('restricts supervisors to their departments', async () => {
    await expect(api('sup1', 'report.run', { type: 'daily', from: yesterday, to: yesterday, departmentId: 'd2' })).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('sup1', 'report.run', { type: 'dtr', from: yesterday, to: yesterday, memberId: f.uid('emp3') })).rejects.toMatchObject({ code: 'permission-denied' });
    const mon = (await api('sup1', 'monitor.daily', {})) as { rows: { departmentId: string }[] };
    expect(mon.rows.length).toBeGreaterThan(0);
    expect(mon.rows.every((r) => r.departmentId === 'd1')).toBe(true);
    await expect(api('emp1', 'monitor.daily', {})).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(api('sup1', 'day.detail', { memberId: f.uid('emp3'), workDate: yesterday })).rejects.toMatchObject({ code: 'permission-denied' });
  });
  it('hides exact coordinates from supervisors but shows them to HR', async () => {
    const date = '2026-02-02';
    const sup = (await api('sup1', 'day.detail', { memberId: f.uid('emp1'), workDate: date })) as { events: { evidence: unknown }[] };
    expect(sup.events.length).toBeGreaterThan(0);
    expect(sup.events.every((e) => e.evidence === null)).toBe(true);
    const hr = (await api('hr', 'day.detail', { memberId: f.uid('emp1'), workDate: date })) as { events: { evidence: { lat: number } | null }[] };
    expect(hr.events[0].evidence?.lat).toBeCloseTo(BASE.lat, 6);
  });
  it('computes a department summary', async () => {
    const r = (await api('hr', 'report.run', { type: 'department_summary', from: '2026-02-02', to: '2026-02-03' })) as { rows: { departmentId: string; expectedDays: number }[] };
    expect(r.rows.find((x) => x.departmentId === 'd1')?.expectedDays).toBeGreaterThan(0);
  });
});

describe('work from home', () => {
  it('lets an employee clock in only at the approved home location, labelled as WFH', async () => {
    const d = localDate(Date.now(), TZ);
    const home = { lat: BASE.lat + 0.3, lng: BASE.lng + 0.3 }; // ~46 km from the office
    const { id } = (await api('emp2', 'request.submit', {
      type: 'wfh', workDate: d, explanation: 'Working from home on the audit report.',
      fieldwork: { startAt: `${d}T00:00`, endAt: `${d}T23:59`, mode: 'alternate_location', purpose: 'Audit report', locationName: 'Home', lat: home.lat, lng: home.lng, radiusMeters: 150 },
    })) as { id: string };
    await expect(api('emp2', 'request.review', { id, decision: 'approve' })).rejects.toMatchObject({ code: 'permission-denied' });
    const res = (await api('sup1', 'request.review', { id, decision: 'approve', remarks: 'OK' })) as { fieldworkAuthorizationId: string };
    const auth = await col(f.orgId, 'fieldworkAuthorizations').doc(res.fieldworkAuthorizationId).get();
    expect(auth.get('category')).toBe('wfh');

    // Clear any punches emp2 may already have today so the next action is a clock-in.
    await col(f.orgId, 'shiftInstances').doc(`${f.uid('emp2')}_${d}`).delete();
    const now = Date.now();
    const far = await processClock(f.uid('emp2'), { requestId: rid(), action: 'IN', location: loc({ lat: home.lat + 0.01, lng: home.lng }, now) });
    expect(far).toMatchObject({ ok: false, code: 'OUTSIDE_GEOFENCE' });
    await clearRateLimits(f.orgId);
    const r = await processClock(f.uid('emp2'), { requestId: rid(), action: 'IN', location: loc(home, now) });
    if (r.ok) {
      expect(r.validation).toBe('wfh_location');
      expect(r.workplaceName).toMatch(/Work from home/);
    } else {
      // Outside today's shift window (e.g. late at night) the sequencing rules apply, not the location.
      expect(['TOO_EARLY', 'SHIFT_CLOSED', 'SHIFT_COMPLETE', 'TOO_SOON']).toContain(r.code);
    }
  });

  it('rejects WFH requests when the organization disables them', async () => {
    await orgRef(f.orgId).update({ 'settings.wfhEnabled': false });
    const d = localDate(Date.now(), TZ);
    await expect(api('emp1', 'request.submit', {
      type: 'wfh', workDate: d, explanation: 'Working from home today.',
      fieldwork: { startAt: `${d}T08:00`, endAt: `${d}T17:00`, mode: 'exemption', purpose: 'Remote work' },
    })).rejects.toMatchObject({ code: 'failed-precondition' });
    await orgRef(f.orgId).update({ 'settings.wfhEnabled': true });
  });
});
