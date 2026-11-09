/**
 * Creates the organization and its FIRST system administrator in a real
 * Firebase project. Run once, from a trusted machine, with Admin credentials:
 *
 *   gcloud auth application-default login        # or set GOOGLE_APPLICATION_CREDENTIALS
 *   node scripts/bootstrap-admin.mjs --project my-project --org candoni \
 *        --org-name "Candoni Accounting" --email admin@example.com \
 *        --full-name "Jane Admin" --employee-number A-0001 [--database candoni-attendance]
 *
 * It prints a one-time password setup link (it never sets or prints a password).
 * Refuses to run against an organization that already has an active system
 * administrator. Afterwards, manage everyone else from the web app.
 */
import { createRequire } from 'node:module';
import { parseArgs } from 'node:util';

const { values: a } = parseArgs({
  options: {
    project: { type: 'string' },
    org: { type: 'string', default: 'candoni' },
    'org-name': { type: 'string' },
    email: { type: 'string' },
    'full-name': { type: 'string' },
    'employee-number': { type: 'string', default: 'ADMIN-0001' },
    department: { type: 'string', default: 'Administration' },
    timezone: { type: 'string', default: 'Asia/Manila' },
    database: { type: 'string', default: '(default)' },
  },
});
for (const k of ['project', 'org-name', 'email', 'full-name']) {
  if (!a[k]) {
    console.error(`Missing --${k}. See the header of this script.`);
    process.exit(1);
  }
}
if (process.env.FIRESTORE_EMULATOR_HOST || process.env.FIREBASE_AUTH_EMULATOR_HOST) {
  console.warn('Note: emulator environment variables are set; writing to the EMULATOR, not production.');
}
if (!/^[a-z0-9-]{3,40}$/.test(a.org)) {
  console.error('--org must be 3-40 lowercase letters, digits or dashes.');
  process.exit(1);
}

const require = createRequire(new URL('../functions/package.json', import.meta.url));
const { initializeApp, applicationDefault } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');
const { getFirestore } = require('firebase-admin/firestore');

initializeApp({ credential: applicationDefault(), projectId: a.project });
const db = a.database === '(default)' ? getFirestore() : getFirestore(a.database);
const auth = getAuth();
const org = db.collection('organizations').doc(a.org);

const admins = await org.collection('members').where('role', '==', 'sysadmin').where('active', '==', true).limit(1).get();
if (!admins.empty) {
  console.error('This organization already has an active system administrator. Use the web app to add more.');
  process.exit(1);
}

let user;
try {
  user = await auth.getUserByEmail(a.email);
  const link = await db.collection('users').doc(user.uid).get();
  if (link.exists && link.get('orgId') !== a.org) {
    console.error('That email belongs to a member of a different organization.');
    process.exit(1);
  }
} catch {
  user = await auth.createUser({ email: a.email, displayName: a['full-name'], password: (await import('node:crypto')).randomBytes(24).toString('base64url') });
}

const now = Date.now();
const orgSnap = await org.get();
const batch = db.batch();
if (!orgSnap.exists) {
  batch.set(org, { name: a['org-name'], shortName: a['org-name'].split(' ')[0], logoUrl: null, settings: { timezone: a.timezone }, createdAt: now });
  batch.set(db.collection('branding').doc(a.org), { name: a['org-name'], shortName: a['org-name'].split(' ')[0], logoUrl: null });
}
const deptRef = org.collection('departments').doc('admin');
batch.set(deptRef, { orgId: a.org, name: a.department, code: 'ADM', active: true }, { merge: true });
batch.set(db.collection('users').doc(user.uid), { orgId: a.org, createdAt: now });
batch.set(org.collection('members').doc(user.uid), {
  uid: user.uid, orgId: a.org, employeeNumber: a['employee-number'], fullName: a['full-name'], email: a.email.toLowerCase(),
  departmentId: 'admin', position: 'System Administrator', classification: 'Regular', supervisorUid: null, supervisorName: null,
  role: 'sysadmin', supervisedDepartmentIds: [], workplaceIds: [], active: true, privacyAcceptedVersion: null,
  searchName: a['full-name'].toLowerCase(), createdAt: now,
});
batch.set(org.collection('auditLogs').doc(), {
  orgId: a.org, actorUid: 'bootstrap-script', actorName: 'Bootstrap script', actorRole: 'system', action: 'bootstrap.sysadmin',
  targetType: 'member', targetId: user.uid, before: null, after: { email: a.email, role: 'sysadmin' }, reason: 'Initial administrator setup', at: now,
});
await batch.commit();
const link = await auth.generatePasswordResetLink(a.email);
console.log(`\nOrganization "${a.org}" ready. System administrator: ${a.email} (uid ${user.uid}).`);
console.log('\nSend this ONE-TIME password setup link to the administrator through a trusted channel:\n');
console.log(link);
console.log('\nNext: sign in, review Settings, then add departments, workplaces, schedules and employees.');
process.exit(0);
