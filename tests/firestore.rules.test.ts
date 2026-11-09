import { assertFails, assertSucceeds, initializeTestEnvironment, type RulesTestEnvironment } from '@firebase/rules-unit-testing';
import { readFileSync } from 'node:fs';
import { collection, doc, getDoc, getDocs, query, setDoc, updateDoc, where, deleteDoc, addDoc } from 'firebase/firestore';
import { afterAll, beforeAll, describe, it } from 'vitest';

let env: RulesTestEnvironment;
const ORG = 'orgA';
const OTHER = 'orgB';

const member = (uid: string, role: string, departmentId: string, extra: Record<string, unknown> = {}) => ({
  uid, orgId: ORG, role, departmentId, supervisedDepartmentIds: [], active: true, fullName: uid, ...extra,
});

beforeAll(async () => {
  const [host, port] = (process.env.FIRESTORE_EMULATOR_HOST ?? '127.0.0.1:8080').split(':');
  env = await initializeTestEnvironment({
    projectId: 'demo-candoni-rules',
    firestore: { rules: readFileSync('firestore.rules', 'utf8'), host, port: Number(port) },
  });
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async (ctx) => {
    const db = ctx.firestore();
    await setDoc(doc(db, 'users/emp1'), { orgId: ORG });
    await setDoc(doc(db, `organizations/${ORG}`), { name: 'A' });
    await setDoc(doc(db, `organizations/${OTHER}`), { name: 'B' });
    await setDoc(doc(db, `organizations/${ORG}/members/emp1`), member('emp1', 'employee', 'd1'));
    await setDoc(doc(db, `organizations/${ORG}/members/emp2`), member('emp2', 'employee', 'd1'));
    await setDoc(doc(db, `organizations/${ORG}/members/emp3`), member('emp3', 'employee', 'd2'));
    await setDoc(doc(db, `organizations/${ORG}/members/gone`), member('gone', 'employee', 'd1', { active: false }));
    await setDoc(doc(db, `organizations/${ORG}/members/sup1`), member('sup1', 'supervisor', 'd1', { supervisedDepartmentIds: ['d1'] }));
    await setDoc(doc(db, `organizations/${ORG}/members/hr`), member('hr', 'hr', 'd1'));
    await setDoc(doc(db, `organizations/${OTHER}/members/outsider`), { ...member('outsider', 'sysadmin', 'd1'), orgId: OTHER });
    await setDoc(doc(db, `organizations/${ORG}/workplaces/w1`), { name: 'Office', active: true });
    for (const [id, m, d] of [['e1', 'emp1', 'd1'], ['e2', 'emp2', 'd1'], ['e3', 'emp3', 'd2']]) {
      await setDoc(doc(db, `organizations/${ORG}/attendanceEvents/${id}`), { memberId: m, departmentId: d, action: 'IN', at: 1 });
      await setDoc(doc(db, `organizations/${ORG}/attendanceLocationEvidence/${id}`), { memberId: m, lat: 1, lng: 2 });
      await setDoc(doc(db, `organizations/${ORG}/correctionRequests/r${id}`), { memberId: m, departmentId: d, status: 'pending' });
    }
    await setDoc(doc(db, `organizations/${ORG}/auditLogs/a1`), { action: 'x' });
    await setDoc(doc(db, `organizations/${ORG}/devices/dev1`), { memberId: 'emp1', departmentId: 'd1', status: 'active', publicKey: 'x' });
    await setDoc(doc(db, `organizations/${ORG}/webauthnChallenges/emp1_auth`), { challenge: 'secret' });
  });
});
afterAll(async () => env?.cleanup());

const as = (uid: string) => env.authenticatedContext(uid).firestore();
const p = (path: string) => `organizations/${ORG}/${path}`;

describe('no client writes', () => {
  it('denies employees writing attendance, profiles, roles or requests', async () => {
    const db = as('emp1');
    await assertFails(setDoc(doc(db, p('attendanceEvents/fake')), { memberId: 'emp1', departmentId: 'd1', action: 'IN', at: 2 }));
    await assertFails(updateDoc(doc(db, p('members/emp1')), { role: 'sysadmin' }));
    await assertFails(updateDoc(doc(db, p('members/emp1')), { workplaceIds: ['w9'] }));
    await assertFails(addDoc(collection(db, p('correctionRequests')), { memberId: 'emp1', departmentId: 'd1', status: 'approved' }));
    await assertFails(setDoc(doc(db, 'users/emp1'), { orgId: OTHER }));
  });
  it('denies even HR direct writes (must use backend functions)', async () => {
    const db = as('hr');
    await assertFails(setDoc(doc(db, p('workplaces/w2')), { name: 'x' }));
    await assertFails(deleteDoc(doc(db, p('auditLogs/a1'))));
    await assertFails(updateDoc(doc(db, p('attendanceEvents/e1')), { at: 5 }));
  });
});

describe('employee read scope', () => {
  it('can read own records only', async () => {
    const db = as('emp1');
    await assertSucceeds(getDoc(doc(db, p('members/emp1'))));
    await assertSucceeds(getDoc(doc(db, p('attendanceEvents/e1'))));
    await assertSucceeds(getDoc(doc(db, p('attendanceLocationEvidence/e1'))));
    await assertSucceeds(getDocs(query(collection(db, p('attendanceEvents')), where('memberId', '==', 'emp1'))));
    await assertFails(getDoc(doc(db, p('members/emp2'))));
    await assertFails(getDoc(doc(db, p('attendanceEvents/e2'))));
    await assertFails(getDoc(doc(db, p('attendanceLocationEvidence/e2'))));
    await assertFails(getDocs(collection(db, p('attendanceEvents'))));
    await assertFails(getDoc(doc(db, p('auditLogs/a1'))));
    await assertSucceeds(getDoc(doc(db, p('workplaces/w1'))));
  });
  it('blocks inactive employees from organization data', async () => {
    const db = as('gone');
    await assertSucceeds(getDoc(doc(db, p('members/gone'))));
    await assertFails(getDoc(doc(db, `organizations/${ORG}`)));
    await assertFails(getDoc(doc(db, p('workplaces/w1'))));
  });
  it('denies unauthenticated access', async () => {
    const db = env.unauthenticatedContext().firestore();
    await assertFails(getDoc(doc(db, `organizations/${ORG}`)));
    await assertFails(getDoc(doc(db, p('workplaces/w1'))));
  });
});

describe('supervisor department scope', () => {
  it('reads their department but not others, and never exact coordinates of others', async () => {
    const db = as('sup1');
    await assertSucceeds(getDoc(doc(db, p('attendanceEvents/e2'))));
    await assertSucceeds(getDoc(doc(db, p('members/emp2'))));
    await assertSucceeds(getDocs(query(collection(db, p('correctionRequests')), where('departmentId', '==', 'd1'))));
    await assertFails(getDoc(doc(db, p('attendanceEvents/e3'))));
    await assertFails(getDoc(doc(db, p('members/emp3'))));
    await assertFails(getDocs(query(collection(db, p('correctionRequests')), where('departmentId', '==', 'd2'))));
    await assertFails(getDocs(collection(db, p('correctionRequests'))));
    await assertFails(getDoc(doc(db, p('attendanceLocationEvidence/e2'))));
    await assertFails(getDoc(doc(db, p('auditLogs/a1'))));
  });
});

describe('registered phones', () => {
  it('lets the owner and HR read a phone record, nobody else, and never challenges', async () => {
    await assertSucceeds(getDoc(doc(as('emp1'), p('devices/dev1'))));
    await assertSucceeds(getDoc(doc(as('hr'), p('devices/dev1'))));
    await assertFails(getDoc(doc(as('emp2'), p('devices/dev1'))));
    await assertFails(getDoc(doc(as('sup1'), p('devices/dev1'))));
    await assertFails(getDoc(doc(as('emp1'), p('webauthnChallenges/emp1_auth'))));
    await assertFails(setDoc(doc(as('emp1'), p('devices/dev2')), { memberId: 'emp1', status: 'active' }));
    await assertFails(updateDoc(doc(as('hr'), p('devices/dev1')), { status: 'revoked' }));
  });
});

describe('HR scope and organization isolation', () => {
  it('lets HR read organization-wide records including evidence and audit logs', async () => {
    const db = as('hr');
    await assertSucceeds(getDocs(collection(db, p('attendanceEvents'))));
    await assertSucceeds(getDoc(doc(db, p('attendanceLocationEvidence/e3'))));
    await assertSucceeds(getDocs(collection(db, p('auditLogs'))));
    await assertSucceeds(getDocs(collection(db, p('members'))));
  });
  it('isolates organizations: an admin of another org sees nothing', async () => {
    const db = as('outsider');
    await assertFails(getDoc(doc(db, `organizations/${ORG}`)));
    await assertFails(getDoc(doc(db, p('members/emp1'))));
    await assertFails(getDocs(collection(db, p('attendanceEvents'))));
    await assertFails(getDoc(doc(db, p('attendanceLocationEvidence/e1'))));
    await assertSucceeds(getDoc(doc(db, `organizations/${OTHER}`)));
  });
});
