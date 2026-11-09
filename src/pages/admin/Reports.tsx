import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { canViewDepartment, isAttendanceAdmin } from '../../../shared/roles';
import { addDays, localDate, monthRange } from '../../../shared/time';
import { ACTION_LABELS, STATUS_LABELS, type AttendanceAction, type DayStatus } from '../../../shared/types';
import { BrandMark } from '../../components/Brand';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, PageLoader, Pager, Select, StatusBadge, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { downloadCsv, toCsv } from '../../lib/csv';
import { fmtDateShort, fmtDateTime, fmtPunch, formatMinutes } from '../../lib/format';
import { useScopedMembers } from '../../lib/hooks';
import type { MonitorRow } from './Dashboard';

/* eslint-disable @typescript-eslint/no-explicit-any */
type ReportType = 'daily' | 'dtr' | 'department_summary' | 'late_undertime' | 'missing_absence' | 'corrections' | 'fieldwork' | 'device_anomalies';
const TYPES: Record<ReportType, string> = {
  daily: 'Daily attendance',
  dtr: 'Individual monthly time record (DTR-style)',
  department_summary: 'Department summary',
  late_undertime: 'Late and undertime summary',
  missing_absence: 'Missing attendance and absences',
  corrections: 'Approved correction history',
  fieldwork: 'Fieldwork & work-from-home attendance',
  device_anomalies: 'Suspicious activity (shared phones)',
};
type Row = MonitorRow & { approvedOvertimeMinutes: number; holidayName: string | null; unscheduled: boolean };

export default function Reports() {
  const { tz, member, departments, branding } = useSession() as ReturnType<typeof useSession>;
  const [params] = useSearchParams();
  const today = localDate(Date.now(), tz);
  const [type, setType] = useState<ReportType>((params.get('type') as ReportType) || 'daily');
  const [from, setFrom] = useState(type === 'dtr' ? monthRange(today.slice(0, 7)).from : today);
  const [to, setTo] = useState(today);
  const [month, setMonth] = useState(today.slice(0, 7));
  const [dept, setDept] = useState('');
  const [memberId, setMemberId] = useState(params.get('member') ?? '');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState<any | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { members } = useScopedMembers();
  const memberOptions = members.filter((m) => !dept || m.departmentId === dept);

  async function run() {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const range = type === 'dtr' ? monthRange(month) : { from, to };
      setResult(await callApi('report.run', { type, ...range, departmentId: dept || undefined, memberId: memberId || undefined, status: status || undefined }));
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-4">
      <h1 className="no-print text-2xl font-bold text-navy-900">Reports</h1>
      <Card className="no-print">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
          <Field label="Report">
            {(id) => (
              <Select id={id} value={type} onChange={(e) => { setType(e.target.value as ReportType); setResult(null); }}>
                {(Object.keys(TYPES) as ReportType[]).filter((t) => t !== 'device_anomalies' || isAttendanceAdmin(member.role)).map((t) => (
                  <option key={t} value={t}>
                    {TYPES[t]}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'dtr' ? (
            <Field label="Month">{(id) => <Input id={id} type="month" value={month} onChange={(e) => setMonth(e.target.value)} />}</Field>
          ) : (
            <>
              <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
              <Field label="To" hint="Up to 62 days">{(id) => <Input id={id} type="date" value={to} max={addDays(from, 61)} onChange={(e) => setTo(e.target.value)} />}</Field>
            </>
          )}
          <Field label="Department">
            {(id) => (
              <Select id={id} value={dept} onChange={(e) => setDept(e.target.value)}>
                <option value="">All in my scope</option>
                {Object.entries(departments)
                  .filter(([d]) => canViewDepartment(member, d))
                  .map(([d, n]) => (
                    <option key={d} value={d}>
                      {n}
                    </option>
                  ))}
              </Select>
            )}
          </Field>
          <Field label={type === 'dtr' ? 'Employee (required)' : 'Employee'}>
            {(id) => (
              <Select id={id} value={memberId} onChange={(e) => setMemberId(e.target.value)}>
                <option value="">{type === 'dtr' ? 'Choose…' : 'All'}</option>
                {memberOptions.map((m) => (
                  <option key={m.uid} value={m.uid}>
                    {m.fullName} ({m.employeeNumber})
                  </option>
                ))}
              </Select>
            )}
          </Field>
          {type === 'daily' && (
            <Field label="Status">
              {(id) => (
                <Select id={id} value={status} onChange={(e) => setStatus(e.target.value)}>
                  <option value="">All</option>
                  {(Object.keys(STATUS_LABELS) as DayStatus[]).map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          )}
        </div>
        <Button className="mt-3" loading={busy} disabled={type === 'dtr' && !memberId} onClick={run}>
          Generate report
        </Button>
        <p className="mt-2 text-xs text-slate-600">Standard exports do not include precise coordinates. Corrected records are marked “Corrected”.</p>
      </Card>
      {error && <Alert tone="danger">{error}</Alert>}
      {busy && <PageLoader label="Computing from attendance records…" />}
      {result && (
        <ReportView
          result={result}
          tz={tz}
          departments={departments}
          orgName={branding.name}
        />
      )}
    </div>
  );
}

function ReportView({ result, tz, departments, orgName }: { result: any; tz: string; departments: Record<string, string>; orgName: string }) {
  const t = result.type as ReportType;
  const rows: any[] = result.rows ?? [];
  const paged = usePaged(rows, 50);
  const fname = `${t}_${result.from}_${result.to}.csv`;
  const header = (
    <div className="no-print flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-slate-600">
        {TYPES[t]} · {result.from} to {result.to} · generated {fmtDateTime(result.generatedAt, tz)} by {result.generatedBy}
      </p>
      <div className="flex gap-2">
        <Button variant="secondary" disabled={!rows.length} onClick={() => exportCsv(result, tz, departments, fname)}>
          ⬇ CSV
        </Button>
        <Button variant="secondary" onClick={() => window.print()}>
          🖨 Print
        </Button>
      </div>
    </div>
  );
  if (!rows.length) return (<>{header}<EmptyState title="No records for these filters" /></>);
  if (t === 'dtr') return (<>{header}<Dtr result={result} tz={tz} orgName={orgName} /></>);
  if (t === 'daily' || t === 'missing_absence') {
    return (
      <Card>
        {header}
        <ResponsiveTable
          head={['Date', 'Employee', 'Department', 'Punches', 'Late', 'Undertime', 'Worked', 'Status']}
          rows={paged.slice.map((r: Row) => [
            fmtDateShort(r.workDate),
            `${r.fullName} (${r.employeeNumber})`,
            departments[r.departmentId] ?? r.departmentId,
            punchCell(r, tz),
            r.lateMinutes ? formatMinutes(r.lateMinutes) : '—',
            r.undertimeMinutes ? formatMinutes(r.undertimeMinutes) : '—',
            formatMinutes(r.workedMinutes),
            <span key="s" className="flex flex-wrap gap-1">
              <StatusBadge status={r.status} />
              {r.correctedActions.length > 0 && <Badge tone="info" icon="✎">Corrected</Badge>}
              {r.missingActions.length > 0 && <Badge tone="danger">Missing {r.missingActions.map((a) => ACTION_LABELS[a]).join(', ')}</Badge>}
            </span>,
          ])}
        />
        <Pager {...paged} />
      </Card>
    );
  }
  if (t === 'department_summary' || t === 'late_undertime') {
    const first = t === 'department_summary' ? 'Department' : 'Employee';
    return (
      <Card>
        {header}
        <ResponsiveTable
          head={[first, 'Expected', 'Present', 'Absent', 'Incomplete', 'Leave', 'Late (times)', 'Late', 'Undertime', 'Worked', 'Potential OT', 'Approved OT', 'Corrected days']}
          rows={paged.slice.map((r) => [
            t === 'department_summary' ? r.departmentName : `${r.fullName} (${r.employeeNumber})`,
            r.expectedDays,
            r.presentDays,
            r.absentDays,
            r.incompleteDays,
            r.leaveDays,
            r.lateCount,
            formatMinutes(r.lateMinutes),
            formatMinutes(r.undertimeMinutes),
            formatMinutes(r.workedMinutes),
            formatMinutes(r.overtimeCandidateMinutes),
            formatMinutes(r.approvedOvertimeMinutes),
            r.correctedDays,
          ])}
        />
        <Pager {...paged} />
      </Card>
    );
  }
  if (t === 'device_anomalies') {
    const SEV: Record<string, ['danger' | 'warning' | 'info', string]> = { high: ['danger', 'High'], medium: ['warning', 'Medium'], info: ['info', 'Info'] };
    return (
      <Card>
        {header}
        <p className="mt-2 text-sm text-slate-600">
          Signals to follow up, not proof. “Same phone” uses a random identifier stored in the browser, which can be cleared. Check with the employees and their supervisor before acting.
        </p>
        <ResponsiveTable
          head={['Severity', 'Finding', 'Employees', 'Phone ID', 'Count', 'First', 'Last']}
          rows={paged.slice.map((r) => [
            <Badge key="s" tone={SEV[r.severity]?.[0] ?? 'info'}>{SEV[r.severity]?.[1] ?? r.severity}</Badge>,
            r.description,
            (r.employees ?? []).join(', '),
            r.device ?? '—',
            r.count,
            fmtDateTime(r.firstAt, tz),
            fmtDateTime(r.lastAt, tz),
          ])}
        />
        <Pager {...paged} />
      </Card>
    );
  }
  if (t === 'corrections') {
    return (
      <Card>
        {header}
        <ResponsiveTable
          head={['Work date', 'Employee', 'Action', 'Before', 'After', 'Reason', 'Approved by', 'When']}
          rows={paged.slice.map((r) => [
            r.workDate,
            r.memberName,
            ACTION_LABELS[r.action as AttendanceAction],
            fmtPunch(r.before, r.workDate, tz),
            r.after == null ? 'voided' : fmtPunch(r.after, r.workDate, tz),
            r.reason,
            r.reviewerName,
            fmtDateTime(r.createdAt, tz),
          ])}
        />
        <Pager {...paged} />
      </Card>
    );
  }
  // fieldwork
  return (
    <Card>
      {header}
      <ResponsiveTable
        head={['Type', 'Employee', 'Purpose', 'Window', 'Rule', 'Approved by', 'Status']}
        rows={paged.slice.map((r) => [
          r.category === 'wfh' ? 'Work from home' : 'Fieldwork',
          r.memberName,
          r.purpose,
          `${fmtDateTime(r.startAt, tz)} – ${fmtDateTime(r.endAt, tz)}`,
          r.mode === 'exemption' ? 'Location exemption' : `${r.locationName} (${r.radiusMeters} m)`,
          r.approvedByName,
          r.active ? 'Active' : `Revoked: ${r.revokeReason ?? ''}`,
        ])}
      />
      <Pager {...paged} />
      <h3 className="mt-4 font-semibold text-navy-900">Attendance recorded under fieldwork or work from home</h3>
      {(result.events ?? []).length === 0 ? (
        <p className="text-sm text-slate-600">None in this period.</p>
      ) : (
        <ResponsiveTable
          head={['Date', 'Employee', 'Action', 'Time', 'Validation']}
          rows={result.events.map((e: any) => [e.workDate, e.memberName, ACTION_LABELS[e.action as AttendanceAction], fmtPunch(e.at, e.workDate, tz), e.workplaceName])}
        />
      )}
    </Card>
  );
}

function punchCell(r: Row, tz: string) {
  const ks = Object.keys(r.punches) as AttendanceAction[];
  if (!ks.length) return '—';
  return ks
    .sort((a, b) => (r.punches[a] ?? 0) - (r.punches[b] ?? 0))
    .map((a) => `${ACTION_LABELS[a]} ${fmtPunch(r.punches[a], r.workDate, tz)}`)
    .join(' · ');
}

function ResponsiveTable({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <>
      <div className="mt-2 hidden overflow-x-auto md:block print:block">
        <table className="w-full text-left text-sm">
          <thead className="text-xs uppercase text-slate-600">
            <tr>
              {head.map((h) => (
                <th key={h} className="border-b border-slate-200 p-2">
                  {h}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i} className="border-b border-slate-100 align-top">
                {r.map((c, j) => (
                  <td key={j} className="tabular p-2">
                    {c}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <ul className="mt-2 flex flex-col gap-2 md:hidden print:hidden">
        {rows.map((r, i) => (
          <li key={i} className="rounded-xl border border-slate-200 p-3 text-sm">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
              {r.map((c, j) => (
                <div key={j} className="contents">
                  <dt className="text-slate-600">{head[j]}</dt>
                  <dd className="tabular min-w-0 break-words">{c}</dd>
                </div>
              ))}
            </dl>
          </li>
        ))}
      </ul>
    </>
  );
}

/** DTR-style monthly layout. Not an official Civil Service Form 48. */
function Dtr({ result, tz, orgName }: { result: any; tz: string; orgName: string }) {
  const rows: Row[] = result.rows;
  const m = result.member;
  const split = rows.some((r) => r.punches.AM_IN || r.punches.PM_IN || r.punches.AM_OUT || r.punches.PM_OUT);
  const cols: AttendanceAction[] = split ? ['AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT'] : ['IN', 'OUT'];
  const totals = useMemo(() => rows.reduce((a, r) => ({ late: a.late + r.lateMinutes, under: a.under + r.undertimeMinutes, worked: a.worked + r.workedMinutes }), { late: 0, under: 0, worked: 0 }), [rows]);
  return (
    <Card className="print-page overflow-x-auto">
      <div className="mb-3 flex items-center gap-3">
        <BrandMark size={40} />
        <div>
          <p className="font-bold text-navy-900">{orgName}</p>
          <p className="text-sm">Monthly Time Record · {result.from.slice(0, 7)}</p>
        </div>
      </div>
      {m && (
        <p className="mb-2 text-sm">
          <strong>{m.fullName}</strong> · {m.employeeNumber} · {m.position} · {m.department}
        </p>
      )}
      <table className="w-full min-w-[640px] border border-slate-300 text-left text-xs">
        <thead className="bg-slate-50">
          <tr>
            <th className="border border-slate-300 p-1">Day</th>
            {cols.map((c) => (
              <th key={c} className="border border-slate-300 p-1">
                {ACTION_LABELS[c]}
              </th>
            ))}
            <th className="border border-slate-300 p-1">Late</th>
            <th className="border border-slate-300 p-1">Undertime</th>
            <th className="border border-slate-300 p-1">Worked</th>
            <th className="border border-slate-300 p-1">Remarks</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.workDate}>
              <td className="border border-slate-300 p-1 whitespace-nowrap">{fmtDateShort(r.workDate)}</td>
              {cols.map((c) => (
                <td key={c} className="tabular border border-slate-300 p-1 whitespace-nowrap">
                  {fmtPunch(r.punches[c], r.workDate, tz)}
                  {r.correctedActions.includes(c) && ' *'}
                </td>
              ))}
              <td className="tabular border border-slate-300 p-1">{r.lateMinutes || ''}</td>
              <td className="tabular border border-slate-300 p-1">{r.undertimeMinutes || ''}</td>
              <td className="tabular border border-slate-300 p-1">{r.workedMinutes ? formatMinutes(r.workedMinutes) : ''}</td>
              <td className="border border-slate-300 p-1">
                {[r.holidayName, ['rest_day', 'leave', 'absent', 'incomplete', 'fieldwork', 'wfh', 'holiday'].includes(r.status) ? STATUS_LABELS[r.status] : null, r.correctedActions.length ? 'Corrected' : null, r.unscheduled ? 'Unscheduled' : null]
                  .filter(Boolean)
                  .join('; ')}
              </td>
            </tr>
          ))}
          <tr className="font-semibold">
            <td className="border border-slate-300 p-1" colSpan={cols.length + 1}>
              Totals (minutes)
            </td>
            <td className="border border-slate-300 p-1">{totals.late}</td>
            <td className="border border-slate-300 p-1">{totals.under}</td>
            <td className="border border-slate-300 p-1">{formatMinutes(totals.worked)}</td>
            <td className="border border-slate-300 p-1" />
          </tr>
        </tbody>
      </table>
      <p className="mt-2 text-xs text-slate-600">* Corrected through an approved adjustment; originals are preserved. Times in {tz}. This is a DTR-style summary generated by the attendance system, not an official Civil Service Form 48.</p>
      <div className="mt-8 grid grid-cols-2 gap-8 text-xs">
        <div className="border-t border-slate-400 pt-1 text-center">Employee signature</div>
        <div className="border-t border-slate-400 pt-1 text-center">Verified by (supervisor)</div>
      </div>
    </Card>
  );
}

function exportCsv(result: any, tz: string, departments: Record<string, string>, fname: string) {
  const t = result.type as ReportType;
  const rows: any[] = result.rows;
  const p = (r: any, a: AttendanceAction) => (r.punches?.[a] ? fmtPunch(r.punches[a], r.workDate, tz) : '');
  if (t === 'daily' || t === 'dtr' || t === 'missing_absence') {
    downloadCsv(
      fname,
      toCsv(
        ['Work date', 'Employee no.', 'Name', 'Department', 'Schedule', 'IN', 'OUT', 'AM IN', 'AM OUT', 'PM IN', 'PM OUT', 'Late min', 'Undertime min', 'Worked min', 'Potential OT min', 'Approved OT min', 'Status', 'Missing', 'Corrected', 'Workplace'],
        rows.map((r) => [
          r.workDate, r.employeeNumber, r.fullName, departments[r.departmentId] ?? r.departmentId, r.scheduleName ?? '',
          p(r, 'IN'), p(r, 'OUT'), p(r, 'AM_IN'), p(r, 'AM_OUT'), p(r, 'PM_IN'), p(r, 'PM_OUT'),
          r.lateMinutes, r.undertimeMinutes, r.workedMinutes, r.overtimeCandidateMinutes, r.approvedOvertimeMinutes,
          STATUS_LABELS[r.status as DayStatus], r.missingActions.join(' '), r.correctedActions.length ? `Yes (${r.correctedActions.join(' ')})` : 'No', r.workplaceNames.join('; '),
        ]),
      ),
    );
  } else if (t === 'department_summary' || t === 'late_undertime') {
    downloadCsv(
      fname,
      toCsv(
        [t === 'department_summary' ? 'Department' : 'Employee', 'Expected days', 'Present', 'Absent', 'Incomplete', 'Leave', 'Fieldwork', 'WFH', 'Late count', 'Late min', 'Undertime min', 'Worked min', 'Potential OT min', 'Approved OT min', 'Corrected days'],
        rows.map((r) => [t === 'department_summary' ? r.departmentName : `${r.fullName} (${r.employeeNumber})`, r.expectedDays, r.presentDays, r.absentDays, r.incompleteDays, r.leaveDays, r.fieldworkDays, r.wfhDays ?? 0, r.lateCount, r.lateMinutes, r.undertimeMinutes, r.workedMinutes, r.overtimeCandidateMinutes, r.approvedOvertimeMinutes, r.correctedDays]),
      ),
    );
  } else if (t === 'device_anomalies') {
    downloadCsv(fname, toCsv(['Severity', 'Kind', 'Finding', 'Employees', 'Phone ID', 'Count', 'First', 'Last'], rows.map((r) => [r.severity, r.kind, r.description, (r.employees ?? []).join('; '), r.device ?? '', r.count, fmtDateTime(r.firstAt, tz), fmtDateTime(r.lastAt, tz)])));
  } else if (t === 'corrections') {
    downloadCsv(
      fname,
      toCsv(
        ['Work date', 'Employee', 'Action', 'Before', 'After', 'Reason', 'Approved by', 'Approved at', 'Request ID', 'Original event ID'],
        rows.map((r) => [r.workDate, r.memberName, r.action, r.before ? fmtDateTime(r.before, tz) : '', r.after ? fmtDateTime(r.after, tz) : 'voided', r.reason, r.reviewerName, fmtDateTime(r.createdAt, tz), r.requestId ?? '', r.originalEventId ?? '']),
      ),
    );
  } else {
    downloadCsv(
      fname,
      toCsv(
        ['Type', 'Employee', 'Purpose', 'Start', 'End', 'Rule', 'Site', 'Radius m', 'Approved by', 'Active'],
        rows.map((r) => [r.category === 'wfh' ? 'Work from home' : 'Fieldwork', r.memberName, r.purpose, fmtDateTime(r.startAt, tz), fmtDateTime(r.endAt, tz), r.mode, r.locationName ?? '', r.radiusMeters ?? '', r.approvedByName, r.active ? 'Yes' : 'No']),
      ),
    );
  }
}
