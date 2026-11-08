import { doc, onSnapshot, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { isAttendanceAdmin, isSysAdmin, ROLE_LABELS } from '../../../shared/roles';
import { assignmentForDate } from '../../../shared/schedule';
import { localDate } from '../../../shared/time';
import type { Role, ScheduleAssignmentDoc, ScheduleDoc, WorkplaceDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, Field, Input, Modal, PageLoader, Select, Textarea, Toast } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { db } from '../../firebase';
import { callApi } from '../../lib/api';
import { useCollection, useScopedMembers, type MemberRow } from '../../lib/hooks';
import { EmployeeForm } from './EmployeeForm';

export default function EmployeeDetail() {
  const { uid = '' } = useParams();
  const { orgId, member: me, departments, tz } = useSession();
  const admin = isAttendanceAdmin(me.role);
  const [m, setM] = useState<MemberRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const { members } = useScopedMembers();
  const { items: workplaces } = useCollection<WorkplaceDoc>(['organizations', orgId, 'workplaces']);
  const { items: schedules } = useCollection<ScheduleDoc>(['organizations', orgId, 'schedules']);
  useEffect(
    () =>
      onSnapshot(
        doc(db, 'organizations', orgId, 'members', uid),
        (s) => (s.exists() ? setM({ ...(s.data() as MemberRow), uid: s.id }) : setError('Employee not found.')),
        () => setError('You do not have access to this employee.'),
      ),
    [orgId, uid],
  );
  if (error) return <Alert tone="danger">{error}</Alert>;
  if (!m) return <PageLoader />;
  const canManage = admin && m.uid !== me.uid && (isSysAdmin(me.role) || !isAttendanceAdmin(m.role));
  const myWorkplaces = (workplaces ?? []).filter((w) => m.workplaceIds?.includes(w.id) || w.departmentIds?.includes(m.departmentId) || w.memberIds?.includes(m.uid));

  return (
    <div className="flex flex-col gap-4">
      <Link to="/admin/employees" className="text-sm font-semibold text-brand-700">
        ← Employees
      </Link>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">{m.fullName}</h1>
          <p className="text-sm text-slate-600">
            {m.employeeNumber} · {departments[m.departmentId] ?? m.departmentId}
          </p>
        </div>
        <div className="flex gap-1">
          <Badge tone="info">{ROLE_LABELS[m.role]}</Badge>
          {m.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}
        </div>
      </div>
      {admin && m.uid === me.uid && <Alert tone="info">You cannot change your own assignments, status or role. Ask another administrator.</Alert>}
      {admin && !canManage && m.uid !== me.uid && <Alert tone="info">Only a system administrator can modify administrator accounts.</Alert>}

      <Card title="Profile" actions={canManage && <Button variant="secondary" onClick={() => setEditing(true)}>Edit</Button>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-600">Email</dt>
          <dd className="break-all">{m.email}</dd>
          <dt className="text-slate-600">Position</dt>
          <dd>{m.position || '—'}</dd>
          <dt className="text-slate-600">Classification</dt>
          <dd>{m.classification || '—'}</dd>
          <dt className="text-slate-600">Supervisor</dt>
          <dd>{m.supervisorName || '—'}</dd>
          <dt className="text-slate-600">Workplaces</dt>
          <dd>{myWorkplaces.length ? myWorkplaces.map((w) => w.name).join(', ') : <span className="text-red-700">None — attendance will be rejected</span>}</dd>
          <dt className="text-slate-600">Privacy notice</dt>
          <dd>{m.privacyAcceptedVersion ? `Accepted v${m.privacyAcceptedVersion}` : 'Not yet accepted'}</dd>
        </dl>
        <Link to={`/admin/reports?type=dtr&member=${m.uid}`} className="mt-3 inline-block text-sm font-semibold text-brand-700 underline">
          View monthly time record →
        </Link>
      </Card>

      {admin && <Assignments memberId={m.uid} schedules={schedules ?? []} canManage={canManage} tz={tz} onToast={setToast} />}
      {canManage && <StatusCard m={m} onToast={setToast} />}
      {isSysAdmin(me.role) && m.uid !== me.uid && <RoleCard m={m} onToast={setToast} />}

      <Modal open={editing} onClose={() => setEditing(false)} title="Edit employee" wide>
        <EmployeeForm
          uid={m.uid}
          initial={{ ...m, supervisorUid: m.supervisorUid ?? null, workplaceIds: m.workplaceIds ?? [] }}
          members={members}
          workplaces={workplaces ?? []}
          onSaved={() => {
            setEditing(false);
            setToast('Employee updated.');
          }}
        />
      </Modal>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function Assignments({ memberId, schedules, canManage, tz, onToast }: { memberId: string; schedules: (ScheduleDoc & { id: string })[]; canManage: boolean; tz: string; onToast: (s: string) => void }) {
  const { orgId } = useSession();
  const { items } = useCollection<ScheduleAssignmentDoc>(['organizations', orgId, 'scheduleAssignments'], [where('memberId', '==', memberId)], memberId);
  const today = localDate(Date.now(), tz);
  const [scheduleId, setScheduleId] = useState('');
  const [from, setFrom] = useState(today);
  const [to, setTo] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const names = Object.fromEntries(schedules.map((s) => [s.id, s.name]));
  const list = [...(items ?? [])].sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  const current = assignmentForDate(list, today);

  async function run(op: string, data: unknown, msg: string) {
    setBusy(true);
    setError(null);
    try {
      await callApi(op, data);
      onToast(msg);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Schedule assignments">
      <p className="mb-2 text-sm text-slate-600">Effective-dated. The latest assignment starting on or before a date applies. Existing shifts keep the schedule they started with.</p>
      {error && <Alert tone="danger" className="mb-2">{error}</Alert>}
      {list.length === 0 && <p className="text-sm text-slate-600">No schedule assigned.</p>}
      <ul className="flex flex-col gap-2 text-sm">
        {list.map((a) => (
          <li key={a.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-2">
            <span>
              <strong>{names[a.scheduleId] ?? a.scheduleId}</strong> · {a.effectiveFrom} → {a.effectiveTo ?? 'open-ended'} {current?.id === a.id && <Badge tone="success">Current</Badge>}
            </span>
            {canManage && (
              <span className="flex gap-1">
                {!a.effectiveTo && a.effectiveFrom <= today && (
                  <Button variant="ghost" disabled={busy} onClick={() => run('assignment.end', { id: a.id, effectiveTo: today }, 'Assignment ended.')}>
                    End today
                  </Button>
                )}
                {a.effectiveFrom > today && (
                  <Button variant="ghost" disabled={busy} onClick={() => run('assignment.end', { id: a.id, effectiveTo: null, remove: true }, 'Assignment removed.')}>
                    Remove
                  </Button>
                )}
              </span>
            )}
          </li>
        ))}
      </ul>
      {canManage && (
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Field label="Schedule">
            {(id) => (
              <Select id={id} value={scheduleId} onChange={(e) => setScheduleId(e.target.value)}>
                <option value="">Choose…</option>
                {schedules
                  .filter((s) => s.active)
                  .map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.name}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label="Effective from">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
          <Field label="Until (optional)">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
          <div className="flex items-end">
            <Button className="w-full" loading={busy} disabled={!scheduleId || !from} onClick={() => run('assignment.create', { memberId, scheduleId, effectiveFrom: from, effectiveTo: to || null }, 'Schedule assigned.')}>
              Assign
            </Button>
          </div>
        </div>
      )}
    </Card>
  );
}

function StatusCard({ m, onToast }: { m: MemberRow; onToast: (s: string) => void }) {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<string | null>(null);
  async function toggle() {
    setBusy(true);
    setError(null);
    try {
      await callApi('employee.setActive', { uid: m.uid, active: !m.active, reason });
      onToast(m.active ? 'Employee deactivated. Existing sessions are blocked.' : 'Employee reactivated.');
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Account">
      {error && <Alert tone="danger" className="mb-2">{error}</Alert>}
      <div className="flex flex-col gap-2">
        <Field label="Reason (recorded in audit log)">{(id) => <Textarea id={id} className="min-h-16" value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Button variant={m.active ? 'danger' : 'teal'} loading={busy} onClick={toggle}>
          {m.active ? 'Deactivate account' : 'Reactivate account'}
        </Button>
        <Button
          variant="secondary"
          onClick={async () => {
            try {
              const r = await callApi<{ resetLink: string }>('employee.resetLink', { uid: m.uid });
              setLink(r.resetLink);
            } catch (e) {
              setError((e as Error).message);
            }
          }}
        >
          Generate password setup/reset link
        </Button>
        {link && <textarea readOnly className="h-20 w-full rounded-xl border border-slate-300 p-2 font-mono text-xs" value={link} aria-label="Reset link" />}
      </div>
    </Card>
  );
}

function RoleCard({ m, onToast }: { m: MemberRow; onToast: (s: string) => void }) {
  const { departments } = useSession();
  const [role, setRole] = useState<Role>(m.role);
  const [depts, setDepts] = useState<string[]>(m.supervisedDepartmentIds ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await callApi('employee.setRole', { uid: m.uid, role, supervisedDepartmentIds: depts });
      onToast('Role updated.');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Role & access (system administrator)">
      {error && <Alert tone="danger" className="mb-2">{error}</Alert>}
      <Field label="Role">
        {(id) => (
          <Select id={id} value={role} onChange={(e) => setRole(e.target.value as Role)}>
            {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
              <option key={r} value={r}>
                {ROLE_LABELS[r]}
              </option>
            ))}
          </Select>
        )}
      </Field>
      {role === 'supervisor' && (
        <fieldset className="mt-2">
          <legend className="text-sm font-medium">Supervised departments</legend>
          {Object.entries(departments).map(([d, n]) => (
            <label key={d} className="flex min-h-11 items-center gap-2">
              <input type="checkbox" className="h-5 w-5 accent-brand-600" checked={depts.includes(d)} onChange={(e) => setDepts(e.target.checked ? [...depts, d] : depts.filter((x) => x !== d))} />
              {n}
            </label>
          ))}
        </fieldset>
      )}
      <Button className="mt-3" loading={busy} onClick={save}>
        Save role
      </Button>
    </Card>
  );
}
