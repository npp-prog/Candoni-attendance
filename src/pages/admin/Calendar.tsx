import { orderBy, where } from 'firebase/firestore';
import { useState } from 'react';
import { localDate } from '../../../shared/time';
import type { HolidayDoc, LeaveDoc } from '../../../shared/types';
import { Alert, PageLoader, Badge, Button, Card, EmptyState, Field, Input, Pager, Select, Toast, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { fmtDateShort } from '../../lib/format';
import { useCollection, useScopedMembers } from '../../lib/hooks';

export default function Calendar() {
  const { orgId, tz } = useSession();
  const [year, setYear] = useState(localDate(Date.now(), tz).slice(0, 4));
  const { items: holidays } = useCollection<HolidayDoc>(['organizations', orgId, 'holidays'], [where('date', '>=', `${year}-01-01`), where('date', '<=', `${year}-12-31`), orderBy('date')], year);
  const { items: leaves } = useCollection<LeaveDoc & { memberName: string }>(['organizations', orgId, 'leaves'], [orderBy('from', 'desc')]);
  const { members } = useScopedMembers();
  const [h, setH] = useState({ date: '', name: '', type: 'regular' });
  const [l, setL] = useState({ memberId: '', from: '', to: '', type: 'Vacation leave', note: '' });
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pagedLeaves = usePaged(leaves ?? [], 15);
  async function run(op: string, data: unknown, msg: string, after?: () => void) {
    setBusy(true);
    setError(null);
    try {
      await callApi(op, data);
      setToast(msg);
      after?.();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">Holidays & leave</h1>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Holiday calendar" actions={<Input aria-label="Year" type="number" className="w-28" value={year} onChange={(e) => setYear(e.target.value)} />}>
        <p className="mb-2 text-sm text-slate-600">Holidays are non-working days for everyone. Work on a holiday is recorded as unscheduled and flagged as potential overtime. Verify official proclamations each year.</p>
        {!holidays && <PageLoader />}
        {holidays && holidays.length === 0 && <EmptyState title={`No holidays for ${year}`} />}
        <ul className="divide-y divide-slate-100">
          {(holidays ?? []).map((x) => (
            <li key={x.id} className="flex min-h-12 items-center justify-between gap-2 py-1">
              <span>
                <strong>{fmtDateShort(x.date)}</strong> · {x.name} <Badge>{x.type}</Badge>
              </span>
              <Button variant="ghost" disabled={busy} onClick={() => confirm(`Delete holiday "${x.name}"?`) && run('holiday.delete', { id: x.id }, 'Holiday deleted.')}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-4">
          <Field label="Date">{(id) => <Input id={id} type="date" value={h.date} onChange={(e) => setH({ ...h, date: e.target.value })} />}</Field>
          <Field label="Name">{(id) => <Input id={id} value={h.name} onChange={(e) => setH({ ...h, name: e.target.value })} />}</Field>
          <Field label="Type">
            {(id) => (
              <Select id={id} value={h.type} onChange={(e) => setH({ ...h, type: e.target.value })}>
                <option value="regular">Regular</option>
                <option value="special">Special non-working</option>
                <option value="company">Company</option>
              </Select>
            )}
          </Field>
          <div className="flex items-end">
            <Button className="w-full" loading={busy} disabled={!h.date || !h.name} onClick={() => run('holiday.upsert', h, 'Holiday saved.', () => setH({ date: '', name: '', type: 'regular' }))}>
              Add holiday
            </Button>
          </div>
        </div>
      </Card>
      <Card title="Approved leave">
        <p className="mb-2 text-sm text-slate-600">Record approved full-day leave so those days are not counted as absences. (Leave filing and balances are outside this version.)</p>
        {leaves && leaves.length === 0 && <EmptyState title="No leave records" />}
        <ul className="divide-y divide-slate-100">
          {pagedLeaves.slice.map((x) => (
            <li key={x.id} className="flex min-h-12 flex-wrap items-center justify-between gap-2 py-1">
              <span>
                <strong>{x.memberName}</strong> · {x.type} · {x.from} → {x.to}
              </span>
              <Button variant="ghost" disabled={busy} onClick={() => confirm('Delete this leave record?') && run('leave.delete', { id: x.id }, 'Leave deleted.')}>
                Delete
              </Button>
            </li>
          ))}
        </ul>
        <Pager {...pagedLeaves} />
        <div className="mt-3 grid grid-cols-1 gap-2 sm:grid-cols-5">
          <Field label="Employee">
            {(id) => (
              <Select id={id} value={l.memberId} onChange={(e) => setL({ ...l, memberId: e.target.value })}>
                <option value="">Choose…</option>
                {members.filter((m) => m.active).map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.fullName}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label="From">{(id) => <Input id={id} type="date" value={l.from} onChange={(e) => setL({ ...l, from: e.target.value })} />}</Field>
          <Field label="To">{(id) => <Input id={id} type="date" value={l.to} onChange={(e) => setL({ ...l, to: e.target.value })} />}</Field>
          <Field label="Type">{(id) => <Input id={id} value={l.type} onChange={(e) => setL({ ...l, type: e.target.value })} />}</Field>
          <div className="flex items-end">
            <Button className="w-full" loading={busy} disabled={!l.memberId || !l.from || !l.to} onClick={() => run('leave.upsert', l, 'Leave recorded.', () => setL({ ...l, memberId: '', from: '', to: '' }))}>
              Record leave
            </Button>
          </div>
        </div>
      </Card>
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}
