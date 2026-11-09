import { sendPasswordResetEmail } from 'firebase/auth';
import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import { ROLE_LABELS, isAttendanceAdmin } from '../../../shared/roles';
import type { WorkplaceDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, PageLoader, Pager, Select, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { auth } from '../../firebase';
import { useCollection, useScopedMembers } from '../../lib/hooks';
import { EmployeeForm } from './EmployeeForm';

export default function Employees() {
  const { member, departments, orgId } = useSession();
  const admin = isAttendanceAdmin(member.role);
  const { members, error, loaded } = useScopedMembers();
  const { items: workplaces } = useCollection<WorkplaceDoc>(['organizations', orgId, 'workplaces']);
  const [search, setSearch] = useState('');
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const [created, setCreated] = useState<{ email: string; resetLink: string | null; emailSent: boolean } | null>(null);
  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return members.filter(
      (m) =>
        (!dept || m.departmentId === dept) &&
        (!status || (status === 'active' ? m.active : !m.active)) &&
        (!q || m.fullName.toLowerCase().includes(q) || m.employeeNumber.toLowerCase().includes(q) || m.email.toLowerCase().includes(q)),
    );
  }, [members, search, dept, status]);
  const paged = usePaged(filtered, 20);

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-navy-900">Employees</h1>
        {admin && (
          <Button variant="teal" onClick={() => setCreating(true)}>
            + Add employee
          </Button>
        )}
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <Field label="Search">{(id) => <Input id={id} type="search" placeholder="Name, number or email" value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
        <Field label="Department">
          {(id) => (
            <Select id={id} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">All</option>
              {Object.entries(departments).map(([d, n]) => (
                <option key={d} value={d}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="active">Active</option>
              <option value="inactive">Inactive</option>
              <option value="">All</option>
            </Select>
          )}
        </Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!loaded && <PageLoader />}
      {loaded && filtered.length === 0 && <EmptyState title="No employees match">Adjust the filters{admin ? ' or add an employee' : ''}.</EmptyState>}
      {filtered.length > 0 && (
        <Card>
          <ul className="divide-y divide-slate-100">
            {paged.slice.map((m) => (
              <li key={m.uid}>
                <Link to={`/admin/employees/${m.uid}`} className="flex min-h-14 flex-wrap items-center justify-between gap-2 py-2 hover:bg-slate-50">
                  <div className="min-w-0">
                    <p className="font-semibold text-navy-900">{m.fullName}</p>
                    <p className="truncate text-xs text-slate-600">
                      {m.employeeNumber} · {departments[m.departmentId] ?? m.departmentId} · {m.position}
                    </p>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {m.role !== 'employee' && <Badge tone="info">{ROLE_LABELS[m.role]}</Badge>}
                    {m.active ? <Badge tone="success">Active</Badge> : <Badge tone="danger">Inactive</Badge>}
                  </div>
                </Link>
              </li>
            ))}
          </ul>
          <Pager {...paged} />
        </Card>
      )}
      <Modal open={creating} onClose={() => setCreating(false)} title="Add employee" wide>
        <EmployeeForm
          members={members}
          workplaces={workplaces ?? []}
          onSaved={async (res) => {
            setCreating(false);
            const email = res.email;
            let emailSent = false;
            if (email) {
              try {
                await sendPasswordResetEmail(auth, email);
                emailSent = true;
              } catch {
                emailSent = false;
              }
            }
            setCreated({ email, resetLink: res.resetLink ?? null, emailSent });
          }}
        />
      </Modal>
      <Modal open={!!created} onClose={() => setCreated(null)} title="Employee created">
        {created && (
          <div className="flex flex-col gap-3 text-sm">
            {created.emailSent ? (
              <Alert tone="success">A password setup email was sent to {created.email}.</Alert>
            ) : (
              <Alert tone="warning">The setup email could not be sent automatically. Share the link below securely.</Alert>
            )}
            {created.resetLink && (
              <>
                <p>One-time password setup link (share only with the employee):</p>
                <textarea readOnly className="h-24 w-full rounded-xl border border-slate-300 p-2 font-mono text-xs" value={created.resetLink} />
                <Button variant="secondary" onClick={() => navigator.clipboard?.writeText(created.resetLink!)}>
                  Copy link
                </Button>
              </>
            )}
          </div>
        )}
      </Modal>
    </div>
  );
}
