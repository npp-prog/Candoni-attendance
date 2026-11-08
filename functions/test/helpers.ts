import { getAuth } from 'firebase-admin/auth';
import { DEFAULT_SETTINGS } from '../../shared/defaults';
import { zonedToUtc } from '../../shared/time';
import type { MemberDoc, ScheduleDoc } from '../../shared/types';
import { col, db, orgRef } from '../src/context';

if (!process.env.FIRESTORE_EMULATOR_HOST) {
  throw new Error('Integration tests must run against the Firestore emulator (npm run test:functions from the repo root).');
}

export const TZ = 'Asia/Manila';
export const BASE = { lat: 14.5896, lng: 120.9811 };
export const north = (m: number) => ({ lat: BASE.lat + m / 111_194.93, lng: BASE.lng });
export const at = (date: string, hhmm: string, dayOffset = 0) => {
  const [h, m] = hhmm.split(':').map(Number);
  return zonedToUtc(date, dayOffset * 1440 + h * 60 + m, TZ);
};
let counter = 0;
export const rid = () => `req-${Date.now().toString(36)}-${(counter++).toString(36)}-abcdef`;

export const regular: Omit<ScheduleDoc, 'id'> = {
  name: 'Regular 8-5', pattern: 'single', sessions: [{ start: '08:00', end: '17:00' }], workDays: [0, 1, 2, 3, 4, 5, 6],
  graceMinutes: 15, breakStart: '12:00', breakEnd: '13:00', flexible: false, flexMinutes: 0, earlyInMinutes: 120,
  cutoffMinutes: 240, overtimeThresholdMinutes: 30, active: true,
};
export const night: Omit<ScheduleDoc, 'id'> = { ...regular, name: 'Night', sessions: [{ start: '22:00', end: '06:00' }], breakStart: null, breakEnd: null };

export interface Fixture {
  orgId: string;
  uid: (name: string) => string;
}

/** Creates an isolated organization with two departments and a set of members. */
export async function seedOrg(orgId: string): Promise<Fixture> {
  const uid = (name: string) => `${orgId}-${name}`;
  await orgRef(orgId).set({ name: `Org ${orgId}`, shortName: orgId, logoUrl: null, settings: { ...DEFAULT_SETTINGS, timezone: TZ } });
  await col(orgId, 'departments').doc('d1').set({ name: 'Finance', code: 'FIN', active: true });
  await col(orgId, 'departments').doc('d2').set({ name: 'Operations', code: 'OPS', active: true });
  await col(orgId, 'workplaces').doc('w1').set({ name: 'Main Office', address: 'Manila', lat: BASE.lat, lng: BASE.lng, radiusMeters: 100, active: true, departmentIds: ['d1'], memberIds: [] });
  await col(orgId, 'workplaces').doc('w2').set({ name: 'Ops Yard', address: 'Far', lat: BASE.lat + 0.05, lng: BASE.lng, radiusMeters: 100, active: true, departmentIds: ['d2'], memberIds: [] });
  await col(orgId, 'schedules').doc('reg').set(regular);
  await col(orgId, 'schedules').doc('night').set(night);
  const people: [string, MemberDoc['role'], string, string[]][] = [
    ['emp1', 'employee', 'd1', []],
    ['emp2', 'employee', 'd1', []],
    ['emp3', 'employee', 'd2', []],
    ['nightemp', 'employee', 'd1', []],
    ['noplace', 'employee', 'd3', []],
    ['sup1', 'supervisor', 'd1', ['d1']],
    ['sup2', 'supervisor', 'd2', ['d2']],
    ['hr', 'hr', 'd1', []],
    ['hr2', 'hr', 'd2', []],
    ['admin', 'sysadmin', 'd1', []],
  ];
  for (const [name, role, dept, supervised] of people) {
    const u = uid(name);
    await getAuth().createUser({ uid: u, email: `${u}@example.test`, password: 'password123' }).catch(() => undefined);
    await db.collection('users').doc(u).set({ orgId });
    const member: MemberDoc = {
      uid: u, orgId, employeeNumber: `${orgId}-${name}`, fullName: `${name} person`, email: `${u}@example.test`, departmentId: dept,
      position: 'Staff', classification: 'Regular', supervisorUid: null, role, supervisedDepartmentIds: supervised, workplaceIds: [],
      active: true, privacyAcceptedVersion: 1,
    };
    await col(orgId, 'members').doc(u).set(member);
    await col(orgId, 'scheduleAssignments').add({ memberId: u, scheduleId: name === 'nightemp' ? 'night' : 'reg', effectiveFrom: '2020-01-01', effectiveTo: null });
  }
  return { orgId, uid };
}

export async function clearRateLimits(orgId: string) {
  const snap = await col(orgId, 'rateLimits').get();
  await Promise.all(snap.docs.map((d) => d.ref.delete()));
}

export const loc = (p: { lat: number; lng: number }, now: number, accuracy = 15, ageMs = 5000) => ({ lat: p.lat, lng: p.lng, accuracy, capturedAt: now - ageMs });
