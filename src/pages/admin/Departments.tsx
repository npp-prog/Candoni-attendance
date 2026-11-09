import { useState } from 'react';
import { Alert, PageLoader, Badge, Button, Card, EmptyState, Field, Input, Modal, Toast } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { useCollection } from '../../lib/hooks';

interface Dept {
  name: string;
  code: string;
  active: boolean;
}

export default function Departments() {
  const { orgId } = useSession();
  const { items, error } = useCollection<Dept>(['organizations', orgId, 'departments']);
  const [edit, setEdit] = useState<(Partial<Dept> & { id?: string }) | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setErr(null);
    try {
      await callApi('department.upsert', { id: edit!.id, name: edit!.name, code: edit!.code ?? '', active: edit!.active ?? true });
      setEdit(null);
      setToast('Department saved.');
    } catch (e) {
      setErr((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const list = [...(items ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy-900">Departments / offices</h1>
        <Button variant="teal" onClick={() => setEdit({ active: true })}>
          + Add
        </Button>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {!items && !error && <PageLoader />}
      {items && list.length === 0 && <EmptyState title="No departments yet" />}
      <Card>
        <ul className="divide-y divide-slate-100">
          {list.map((d) => (
            <li key={d.id} className="flex min-h-14 items-center justify-between gap-2 py-2">
              <span>
                <strong>{d.name}</strong> <span className="text-sm text-slate-600">{d.code}</span>
              </span>
              <span className="flex items-center gap-2">
                {d.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}
                <Button variant="ghost" onClick={() => setEdit(d)}>
                  Edit
                </Button>
              </span>
            </li>
          ))}
        </ul>
      </Card>
      <Modal open={!!edit} onClose={() => setEdit(null)} title={edit?.id ? 'Edit department' : 'Add department'}>
        {edit && (
          <div className="flex flex-col gap-3">
            {err && <Alert tone="danger">{err}</Alert>}
            <Field label="Name">{(id) => <Input id={id} value={edit.name ?? ''} onChange={(e) => setEdit({ ...edit, name: e.target.value })} />}</Field>
            <Field label="Code">{(id) => <Input id={id} value={edit.code ?? ''} onChange={(e) => setEdit({ ...edit, code: e.target.value })} />}</Field>
            <label className="flex min-h-11 items-center gap-2">
              <input type="checkbox" className="h-5 w-5" checked={edit.active ?? true} onChange={(e) => setEdit({ ...edit, active: e.target.checked })} /> Active
            </label>
            <Button loading={busy} disabled={!edit.name} onClick={save}>
              Save
            </Button>
          </div>
        )}
      </Modal>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
