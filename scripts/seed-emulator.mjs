/**
 * DEVELOPMENT SEED DATA — EMULATOR ONLY.
 *
 * Populates the local Firebase Emulator Suite with a sample organization,
 * departments, workplaces, schedules, holidays and test accounts. All
 * accounts use the same development password printed below. This script
 * forces emulator hosts and a demo- project id, so it cannot write to a real
 * Firebase project.
 *
 * Usage: npm run emulators:fresh   (in one terminal)
 *        npm run seed              (in another)
 */
import { createRequire } from 'node:module';

process.env.FIRESTORE_EMULATOR_HOST = '127.0.0.1:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = '127.0.0.1:9099';
const PROJECT = 'demo-candoni';
const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

const ORG = process.env.SEED_ORG_ID || 'candoni';
const DEV_PASSWORD = 'DevOnly-Password1!';
initializeApp({ projectId: PROJECT });
const db = getFirestore();
const auth = getAuth();
const org = db.collection('organizations').doc(ORG);

const MAIN = { lat: 14.5896, lng: 120.9811 }; // sample coordinates (Manila) — DEV ONLY
const WAREHOUSE = { lat: 14.5547, lng: 121.0244 };

async function upsertUser(email, uid) {
  try {
    await auth.getUser(uid);
    await auth.updateUser(uid, { email, password: DEV_PASSWORD, disabled: false });
  } catch {
    await auth.createUser({ uid, email, password: DEV_PASSWORD, emailVerified: true });
  }
}

async function main() {
  await org.set({ name: 'Candoni Demo Organization (DEV)', shortName: 'Candoni', logoUrl: null, settings: { timezone: 'Asia/Manila', maxAccuracyMeters: 100, maxLocationAgeSeconds: 60, minActionIntervalSeconds: 60, allowUnscheduledAttendance: true, unscheduledMaxHours: 16, approvalMode: 'supervisor_or_hr', privacyNoticeVersion: 1 }, seededForDevelopment: true });
  await db.collection('branding').doc(ORG).set({ name: 'Candoni Demo Organization (DEV)', shortName: 'Candoni', logoUrl: null });

  const departments = { fin: ['Finance Office', 'FIN'], ops: ['Operations', 'OPS'], hr: ['Human Resources', 'HRD'] };
  for (const [id, [name, code]] of Object.entries(departments)) await org.collection('departments').doc(id).set({ name, code, active: true, orgId: ORG });

  await org.collection('workplaces').doc('main').set({ orgId: ORG, name: 'Main Office (DEV sample)', address: 'Sample address, Manila', ...MAIN, radiusMeters: 150, active: true, departmentIds: ['fin', 'hr'], memberIds: [] });
  await org.collection('workplaces').doc('warehouse').set({ orgId: ORG, name: 'Operations Warehouse (DEV sample)', address: 'Sample address, Makati', ...WAREHOUSE, radiusMeters: 200, active: true, departmentIds: ['ops'], memberIds: [] });

  const base = { graceMinutes: 15, flexible: false, flexMinutes: 0, earlyInMinutes: 120, cutoffMinutes: 240, overtimeThresholdMinutes: 30, active: true, orgId: ORG };
  const schedules = {
    regular: { ...base, name: 'Regular 8:00–17:00', pattern: 'single', sessions: [{ start: '08:00', end: '17:00' }], workDays: [1, 2, 3, 4, 5], breakStart: '12:00', breakEnd: '13:00' },
    split: { ...base, name: 'AM/PM 8–12, 1–5', pattern: 'split', sessions: [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }], workDays: [1, 2, 3, 4, 5], breakStart: null, breakEnd: null },
    night: { ...base, name: 'Night 22:00–06:00', pattern: 'single', sessions: [{ start: '22:00', end: '06:00' }], workDays: [0, 1, 2, 3, 4, 5], breakStart: '02:00', breakEnd: '03:00' },
    flex: { ...base, name: 'Flexible 7:00–16:00 (+2h)', pattern: 'single', sessions: [{ start: '07:00', end: '16:00' }], workDays: [1, 2, 3, 4, 5], breakStart: '12:00', breakEnd: '13:00', flexible: true, flexMinutes: 120, graceMinutes: 0 },
    always: { ...base, name: 'Every day 00:00–23:59 (DEV testing)', pattern: 'single', sessions: [{ start: '00:00', end: '23:59' }], workDays: [0, 1, 2, 3, 4, 5, 6], breakStart: null, breakEnd: null, earlyInMinutes: 0, cutoffMinutes: 0 },
  };
  for (const [id, s] of Object.entries(schedules)) await org.collection('schedules').doc(id).set(s);

  const holidays = [
    ['2026-12-25', 'Christmas Day (DEV sample — verify official list)', 'regular'],
    ['2026-12-30', 'Rizal Day (DEV sample — verify official list)', 'regular'],
    ['2027-01-01', 'New Year’s Day (DEV sample — verify official list)', 'regular'],
  ];
  for (const [date, name, type] of holidays) await org.collection('holidays').doc(date).set({ orgId: ORG, date, name, type });

  const people = [
    ['dev-admin', 'admin@candoni.dev', 'System Admin (DEV)', 'sysadmin', 'hr', 'regular', [], 1],
    ['dev-hr', 'hr@candoni.dev', 'Hanna Reyes (DEV HR)', 'hr', 'hr', 'regular', [], 1],
    ['dev-supervisor', 'supervisor@candoni.dev', 'Sam Villanueva (DEV Supervisor)', 'supervisor', 'fin', 'regular', ['fin'], 1],
    ['dev-employee', 'employee@candoni.dev', 'Erin Santos (DEV Employee)', 'employee', 'fin', 'always', [], null],
    ['dev-split', 'split@candoni.dev', 'Paolo Cruz (DEV AM/PM)', 'employee', 'fin', 'split', [], 1],
    ['dev-night', 'night@candoni.dev', 'Nina Garcia (DEV Night)', 'employee', 'ops', 'night', [], 1],
    ['dev-flex', 'flex@candoni.dev', 'Felix Dizon (DEV Flexible)', 'employee', 'ops', 'flex', [], 1],
    ['dev-inactive', 'inactive@candoni.dev', 'Ivan Lim (DEV Inactive)', 'employee', 'fin', 'regular', [], 1],
  ];
  let n = 1;
  for (const [uid, email, fullName, role, dept, schedule, supervised, privacy] of people) {
    await upsertUser(email, uid);
    const active = uid !== 'dev-inactive';
    if (!active) await auth.updateUser(uid, { disabled: true });
    await db.collection('users').doc(uid).set({ orgId: ORG });
    await org.collection('members').doc(uid).set({
      uid, orgId: ORG, employeeNumber: `DEV-${String(n++).padStart(4, '0')}`, fullName, email, departmentId: dept,
      position: role === 'employee' ? 'Staff' : role === 'supervisor' ? 'Department Head' : 'Administrator', classification: 'Regular',
      supervisorUid: role === 'employee' && dept === 'fin' ? 'dev-supervisor' : null, supervisorName: role === 'employee' && dept === 'fin' ? 'Sam Villanueva (DEV Supervisor)' : null,
      role, supervisedDepartmentIds: supervised, workplaceIds: [], active, privacyAcceptedVersion: privacy, searchName: fullName.toLowerCase(),
    });
    const existing = await org.collection('scheduleAssignments').where('memberId', '==', uid).get();
    for (const d of existing.docs) await d.ref.delete();
    await org.collection('scheduleAssignments').add({ orgId: ORG, memberId: uid, scheduleId: schedule, effectiveFrom: '2026-01-01', effectiveTo: null });
  }
  console.log(`\nSeeded organization "${ORG}" in the EMULATOR (project ${PROJECT}).`);
  console.log(`All DEV accounts use password: ${DEV_PASSWORD}`);
  for (const p of people) console.log(`  ${p[3].padEnd(10)} ${p[1]}`);
  console.log('\nemployee@candoni.dev has an always-open schedule and has NOT accepted the privacy notice (shows first-login flow).');
  console.log(`Main Office geofence center: ${MAIN.lat}, ${MAIN.lng} (radius 150 m). Use browser devtools “Sensors” to emulate this location.`);
}

main().then(() => process.exit(0), (e) => { console.error(e); process.exit(1); });
