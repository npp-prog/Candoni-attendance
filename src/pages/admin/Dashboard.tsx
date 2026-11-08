import { useMemo, useState } from 'react';
import { actionSequence } from '../../../shared/attendance';
import { canViewDepartment } from '../../../shared/roles';
import { localDate } from '../../../shared/time';
import { STATUS_LABELS, type DayComputation, type DayStatus } from '../../../shared/types';
import { DayDetailModal } from '../../components/DayDetail';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageLoader, Pager, Select, StatusBadge, useAsync, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { fmtDateTime, fmtPunch, formatMinutes } from '../../lib/format';

export type MonitorRow = DayComputation & {
  memberId: string;
  fullName: string;
  employeeNumber: string;
  departmentId: string;
  scheduleName: string | null;
  hasFieldwork: boolean;
  hasWfh: boolean;
  onLeave: boolean;
  workplaceNames: string[];
};
interface Monitor {
  date: string;
  serverTime: number;
  summary: Record<string, number>;
  rows: MonitorRow[];
}

const TILES: [string, string, string][] = [
  ['expected', 'Expected today', 'Scheduled workday, not on leave'],
  ['clockedIn', 'Clocked in', 'At least one accepted action'],
  ['late', 'Late', 'Arrived after the grace period'],
  ['completed', 'Completed', 'All actions recorded'],
  ['incomplete', 'Incomplete', 'Missing actions after cutoff'],
  ['fieldwork', 'Approved fieldwork', 'Covered by an authorization'],
  ['wfh', 'Work from home', 'Approved work-from-home today'],
  ['absent', 'Absent', 'Only after the shift cutoff'],
];

export default function Dashboard() {
  const { tz, member, departments } = useSession();
  const [date, setDate] = useState(localDate(Date.now(), tz));
  const [dept, setDept] = useState('');
  const [status, setStatus] = useState('');
  const [search, setSearch] = useState('');
  const [open, setOpen] = useState<MonitorRow | null>(null);
  const { data, loading, error, reload } = useAsync(() => callApi<Monitor>('monitor.daily', { date, departmentId: dept || undefined }), [date, dept]);
  const rows = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (data?.rows ?? []).filter((r) => (!status || r.status === status || (status === 'late' && r.lateMinutes > 0)) && (!q || r.fullName.toLowerCase().includes(q) || r.employeeNumber.toLowerCase().includes(q)));
  }, [data, status, search]);
  const paged = usePaged(rows, 25);
  const deptOptions = Object.entries(departments).filter(([id]) => canViewDepartment(member, id));

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-2">
        <div>
          <h1 className="text-2xl font-bold text-navy-900">Daily attendance</h1>
          {data && <p className="text-sm text-slate-600">As of {fmtDateTime(data.serverTime, tz)}</p>}
        </div>
        <Button variant="secondary" onClick={reload}>
          ↻ Refresh
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-4">
        <Field label="Date">{(id) => <Input id={id} type="date" value={date} onChange={(e) => e.target.value && setDate(e.target.value)} />}</Field>
        <Field label="Department">
          {(id) => (
            <Select id={id} value={dept} onChange={(e) => setDept(e.target.value)}>
              <option value="">All in my scope</option>
              {deptOptions.map(([id2, n]) => (
                <option key={id2} value={id2}>
                  {n}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Status">
          {(id) => (
            <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
              <option value="">All statuses</option>
              <option value="late">Late</option>
              {(Object.keys(STATUS_LABELS) as DayStatus[]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABELS[s]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Search">{(id) => <Input id={id} type="search" placeholder="Name or employee no." value={search} onChange={(e) => setSearch(e.target.value)} />}</Field>
      </div>
      {error && <Alert tone="danger">{error}</Alert>}
      {loading && !data && <PageLoader />}
      {data && (
        <>
          <ul className="grid grid-cols-2 gap-2 sm:grid-cols-4 lg:grid-cols-8">
            {TILES.map(([k, label, hint]) => (
              <li key={k} className="rounded-2xl border border-slate-200 bg-white p-3" title={hint}>
                <p className="text-xs font-medium text-slate-600">{label}</p>
                <p className="tabular text-2xl font-bold text-navy-900">{data.summary[k] ?? 0}</p>
              </li>
            ))}
          </ul>
          <p className="text-xs text-slate-600">Absences are counted only after each shift’s cutoff. Before then, employees without punches appear as “Awaiting clock-in”.</p>
          {rows.length === 0 ? (
            <EmptyState title="No matching employees">Try another date, department, or status.</EmptyState>
          ) : (
            <Card>
              <div className="hidden overflow-x-auto md:block">
                <table className="w-full text-left text-sm">
                  <thead className="text-xs uppercase text-slate-600">
                    <tr>
                      <th className="p-2">Employee</th>
                      <th className="p-2">Schedule</th>
                      <th className="p-2">Punches</th>
                      <th className="p-2">Late</th>
                      <th className="p-2">Status</th>
                    </tr>
                  </thead>
                  <tbody>
                    {paged.slice.map((r) => (
                      <tr key={r.memberId} className="cursor-pointer border-t border-slate-100 hover:bg-slate-50" onClick={() => setOpen(r)}>
                        <td className="p-2">
                          <p className="font-semibold">{r.fullName}</p>
                          <p className="text-xs text-slate-600">
                            {r.employeeNumber} · {departments[r.departmentId] ?? r.departmentId}
                          </p>
                        </td>
                        <td className="p-2 text-slate-700">{r.scheduleName ?? '—'}</td>
                        <td className="tabular p-2">{punchText(r, tz)}</td>
                        <td className="p-2">{r.lateMinutes ? formatMinutes(r.lateMinutes) : '—'}</td>
                        <td className="p-2">
                          <div className="flex flex-wrap gap-1">
                            <StatusBadge status={r.status} />
                            {r.correctedActions.length > 0 && <Badge tone="info" icon="✎">Corrected</Badge>}
                            {r.hasFieldwork && <Badge tone="info" icon="⚑">Fieldwork</Badge>}
                            {r.hasWfh && <Badge tone="info" icon="⌂">WFH</Badge>}
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <ul className="flex flex-col divide-y divide-slate-100 md:hidden">
                {paged.slice.map((r) => (
                  <li key={r.memberId}>
                    <button className="w-full py-3 text-left" onClick={() => setOpen(r)}>
                      <div className="flex items-center justify-between gap-2">
                        <span className="font-semibold">{r.fullName}</span>
                        <StatusBadge status={r.status} />
                      </div>
                      <p className="text-xs text-slate-600">{departments[r.departmentId] ?? r.departmentId}</p>
                      <p className="tabular text-sm">{punchText(r, tz)}</p>
                      {r.lateMinutes > 0 && <Badge tone="warning">Late {formatMinutes(r.lateMinutes)}</Badge>}
                    </button>
                  </li>
                ))}
              </ul>
              <Pager {...paged} />
            </Card>
          )}
        </>
      )}
      {open && <DayDetailModal memberId={open.memberId} workDate={open.workDate} title={`${open.fullName} · ${open.workDate}`} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

export function punchText(r: Pick<MonitorRow, 'punches' | 'workDate'>, tz: string) {
  const keys = Object.keys(r.punches);
  if (!keys.length) return '—';
  const seq = actionSequence(r.punches.AM_IN || r.punches.PM_IN || r.punches.AM_OUT || r.punches.PM_OUT ? 'split' : 'single');
  return seq.map((a) => fmtPunch(r.punches[a], r.workDate, tz)).join(' / ');
}
