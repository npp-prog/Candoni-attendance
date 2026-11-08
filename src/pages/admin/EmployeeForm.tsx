import { useState } from 'react';
import { ROLE_LABELS, isSysAdmin } from '../../../shared/roles';
import type { Role, WorkplaceDoc } from '../../../shared/types';
import { Alert, Button, Field, Input, Select } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import type { MemberRow } from '../../lib/hooks';

export interface ProfileValues {
  employeeNumber: string;
  fullName: string;
  email: string;
  departmentId: string;
  position: string;
  classification: string;
  supervisorUid: string | null;
  workplaceIds: string[];
  role?: Role;
}

const CLASSIFICATIONS = ['Regular', 'Probationary', 'Contractual', 'Job Order', 'Casual', 'Part-time', 'Intern'];

export function EmployeeForm({
  initial,
  uid,
  members,
  workplaces,
  onSaved,
}: {
  initial?: Partial<ProfileValues>;
  uid?: string;
  members: MemberRow[];
  workplaces: (WorkplaceDoc & { id: string })[];
  onSaved: (res: { uid?: string; resetLink?: string | null; email: string }) => void;
}) {
  const { departments, member } = useSession();
  const [v, setV] = useState<ProfileValues>({
    employeeNumber: '',
    fullName: '',
    email: '',
    departmentId: Object.keys(departments)[0] ?? '',
    position: '',
    classification: 'Regular',
    supervisorUid: null,
    workplaceIds: [],
    role: 'employee',
    ...initial,
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = <K extends keyof ProfileValues>(k: K, val: ProfileValues[K]) => setV((s) => ({ ...s, [k]: val }));

  async function save() {
    setBusy(true);
    setError(null);
    try {
      const payload = { ...v, supervisorUid: v.supervisorUid || null };
      if (uid) {
        delete payload.role;
        await callApi('employee.update', { ...payload, uid });
        onSaved({ email: v.email });
      } else {
        onSaved({ ...(await callApi<{ uid: string; resetLink: string | null }>('employee.create', payload)), email: v.email });
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error && <Alert tone="danger">{error}</Alert>}
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Field label="Employee number">{(id) => <Input id={id} value={v.employeeNumber} onChange={(e) => set('employeeNumber', e.target.value)} />}</Field>
        <Field label="Full name">{(id) => <Input id={id} value={v.fullName} onChange={(e) => set('fullName', e.target.value)} />}</Field>
        <Field label="Email (sign-in)">{(id) => <Input id={id} type="email" value={v.email} onChange={(e) => set('email', e.target.value)} />}</Field>
        <Field label="Department / office">
          {(id) => (
            <Select id={id} value={v.departmentId} onChange={(e) => set('departmentId', e.target.value)}>
              {Object.entries(departments).map(([d, n]) => (
                <option key={d} value={d}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Position">{(id) => <Input id={id} value={v.position} onChange={(e) => set('position', e.target.value)} />}</Field>
        <Field label="Employment classification">
          {(id) => (
            <Select id={id} value={v.classification} onChange={(e) => set('classification', e.target.value)}>
              {[...new Set([...CLASSIFICATIONS, v.classification])].filter(Boolean).map((c) => (
                <option key={c}>{c}</option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Assigned supervisor">
          {(id) => (
            <Select id={id} value={v.supervisorUid ?? ''} onChange={(e) => set('supervisorUid', e.target.value || null)}>
              <option value="">None</option>
              {members
                .filter((m) => m.uid !== uid && m.role !== 'employee')
                .map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.fullName}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        {!uid && isSysAdmin(member.role) && (
          <Field label="Role">
            {(id) => (
              <Select id={id} value={v.role} onChange={(e) => set('role', e.target.value as Role)}>
                {(Object.keys(ROLE_LABELS) as Role[]).map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
        )}
      </div>
      <fieldset>
        <legend className="text-sm font-medium text-slate-800">Individually authorized workplaces</legend>
        <p className="text-xs text-slate-600">Workplaces assigned to the employee’s department are authorized automatically.</p>
        <div className="mt-2 grid grid-cols-1 gap-1 sm:grid-cols-2">
          {workplaces.map((w) => (
            <label key={w.id} className="flex min-h-11 items-center gap-2 rounded-lg px-2 hover:bg-slate-50">
              <input
                type="checkbox"
                className="h-5 w-5 accent-brand-600"
                checked={v.workplaceIds.includes(w.id)}
                onChange={(e) => set('workplaceIds', e.target.checked ? [...v.workplaceIds, w.id] : v.workplaceIds.filter((x) => x !== w.id))}
              />
              <span>
                {w.name} {!w.active && <span className="text-xs text-slate-500">(inactive)</span>}
                {w.departmentIds.includes(v.departmentId) && <span className="text-xs text-brand-700"> · via department</span>}
              </span>
            </label>
          ))}
        </div>
      </fieldset>
      <Button loading={busy} disabled={!v.employeeNumber || !v.fullName || !v.email || !v.departmentId} onClick={save}>
        {uid ? 'Save changes' : 'Create employee'}
      </Button>
    </div>
  );
}
