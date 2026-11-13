import { useState } from 'react';
import { actionSequence } from '../../../shared/attendance';
import { localDate } from '../../../shared/time';
import { ACTION_LABELS, type DayComputation } from '../../../shared/types';
import { DayDetailModal } from '../../components/DayDetail';
import { Alert, Badge, Card, EmptyState, Field, Input, PageLoader, StatusBadge, useAsync } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { fmtDateShort, fmtPunch, formatMinutes } from '../../lib/format';

type Row = DayComputation & { scheduleName: string | null; holidayName: string | null; approvedOvertimeMinutes: number; overtimeStatus: 'none' | 'pending' | 'approved' | 'rejected'; workplaceNames: string[] };

export default function History() {
  const { tz, user } = useSession();
  const [month, setMonth] = useState(localDate(Date.now(), tz).slice(0, 7));
  const [open, setOpen] = useState<string | null>(null);
  const { data, loading, error, reload } = useAsync(() => callApi<{ rows: Row[] }>('me.history', { month }), [month]);
  const rows = data?.rows ?? [];
  const totals = rows.reduce(
    (a, r) => ({ late: a.late + r.lateMinutes, under: a.under + r.undertimeMinutes, worked: a.worked + r.workedMinutes, absent: a.absent + (r.status === 'absent' ? 1 : 0) }),
    { late: 0, under: 0, worked: 0, absent: 0 },
  );
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">Attendance history</h1>
      <Field label="Month">{(id) => <Input id={id} type="month" value={month} max={localDate(Date.now(), tz).slice(0, 7)} onChange={(e) => e.target.value && setMonth(e.target.value)} />}</Field>
      {loading && <PageLoader />}
      {error && <Alert tone="danger">{error}</Alert>}
      {data && (
        <>
          <div className="grid grid-cols-2 gap-2 text-center sm:grid-cols-4">
            <Stat label="Worked" value={formatMinutes(totals.worked)} />
            <Stat label="Late" value={formatMinutes(totals.late)} />
            <Stat label="Undertime" value={formatMinutes(totals.under)} />
            <Stat label="Absences" value={String(totals.absent)} />
          </div>
          {rows.length === 0 && <EmptyState title="No records for this month yet" />}
          <ul className="flex flex-col gap-2">
            {rows.map((r) => (
              <li key={r.workDate}>
                <button className="w-full text-left" onClick={() => setOpen(r.workDate)}>
                  <Card className="hover:border-brand-500">
                    <div className="flex items-center justify-between gap-2">
                      <span className="font-semibold text-navy-900">{fmtDateShort(r.workDate)}</span>
                      <StatusBadge status={r.status} />
                    </div>
                    {Object.keys(r.punches).length > 0 && (
                      <p className="tabular mt-1 text-sm text-slate-700">
                        {[...actionSequence(r.punches.AM_IN || r.punches.PM_IN ? 'split' : 'single'), ...(r.punches.OT_IN != null ? (['OT_IN', 'OT_OUT'] as const) : [])]
                          .map((a) => `${ACTION_LABELS[a]} ${fmtPunch(r.punches[a], r.workDate, tz)}`)
                          .join(' · ')}
                      </p>
                    )}
                    <div className="mt-1 flex flex-wrap gap-1">
                      {r.holidayName && <Badge icon="★">{r.holidayName}</Badge>}
                      {r.lateMinutes > 0 && <Badge tone="warning">Late {formatMinutes(r.lateMinutes)}</Badge>}
                      {r.undertimeMinutes > 0 && <Badge tone="warning">Undertime {formatMinutes(r.undertimeMinutes)}</Badge>}
                      {r.missingActions.length > 0 && <Badge tone="danger">Missing {r.missingActions.map((a) => ACTION_LABELS[a]).join(', ')}</Badge>}
                      {r.correctedActions.length > 0 && <Badge tone="info" icon="✎">Corrected</Badge>}
                      {r.overtimeCandidateMinutes > 0 && <Badge tone="neutral" icon="+">Potential OT {formatMinutes(r.overtimeCandidateMinutes)}</Badge>}
                      {r.otWorkedMinutes > 0 && (
                        <Badge tone={r.overtimeStatus === 'approved' ? 'success' : r.overtimeStatus === 'rejected' ? 'danger' : 'warning'} icon="⏱">
                          Overtime {formatMinutes(r.otWorkedMinutes)} · {r.overtimeStatus === 'approved' ? `approved ${formatMinutes(r.approvedOvertimeMinutes)}` : r.overtimeStatus === 'rejected' ? 'not approved' : 'pending approval'}
                        </Badge>
                      )}
                      {r.otWorkedMinutes === 0 && r.approvedOvertimeMinutes > 0 && <Badge tone="success">Approved OT {formatMinutes(r.approvedOvertimeMinutes)}</Badge>}
                    </div>
                  </Card>
                </button>
              </li>
            ))}
          </ul>
        </>
      )}
      {open && <DayDetailModal memberId={user.uid} workDate={open} title={`Details for ${fmtDateShort(open)}`} onClose={() => setOpen(null)} onChanged={reload} />}
    </div>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2">
      <p className="text-xs text-slate-600">{label}</p>
      <p className="tabular font-bold text-navy-900">{value}</p>
    </div>
  );
}
