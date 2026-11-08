import { useState } from 'react';
import { mapLinks } from '../../shared/geo';
import { isAttendanceAdmin } from '../../shared/roles';
import { zonedToUtc } from '../../shared/time';
import { ACTION_LABELS, REQUEST_TYPE_LABELS, type AttendanceAction, type RequestType } from '../../shared/types';
import { useSession } from '../context/AuthContext';
import { callApi } from '../lib/api';
import { fmtDateTime, fmtMeters, fmtPunch, toLocalInput } from '../lib/format';
import { Alert, Badge, Button, Field, Input, Modal, PageLoader, Select, Textarea, useAsync } from './ui';

/* eslint-disable @typescript-eslint/no-explicit-any */
interface Detail {
  events: any[];
  adjustments: any[];
  requests: any[];
}

const VALIDATION_LABEL: Record<string, string> = {
  geofence: 'Workplace geofence',
  fieldwork_location: 'Approved fieldwork location',
  fieldwork_exemption: 'Fieldwork exemption',
  wfh_location: 'Approved work-from-home location',
  wfh_exemption: 'Work from home (location exemption)',
};

/** Original events, adjustments (before → after) and requests for one employee-day. */
export function DayDetailModal({ memberId, workDate, title, onClose, onChanged }: { memberId: string; workDate: string; title: string; onClose: () => void; onChanged?: () => void }) {
  const { member, tz } = useSession();
  const { data, loading, error, reload } = useAsync(() => callApi<Detail>('day.detail', { memberId, workDate }), [memberId, workDate]);
  const canAdjust = isAttendanceAdmin(member.role) && member.uid !== memberId;
  const [adjusting, setAdjusting] = useState(false);
  return (
    <Modal open title={title} onClose={onClose} wide>
      {loading && <PageLoader />}
      {error && <Alert tone="danger">{error}</Alert>}
      {data && (
        <div className="flex flex-col gap-4 text-sm">
          <section>
            <h3 className="mb-2 font-semibold text-navy-900">Original attendance events</h3>
            {data.events.length === 0 ? (
              <p className="text-slate-600">No accepted events.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.events.map((e) => (
                  <li key={e.id} className="rounded-xl border border-slate-200 p-3">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <span className="font-semibold">{ACTION_LABELS[e.action as AttendanceAction]}</span>
                      <span className="tabular font-semibold">{fmtPunch(e.at, workDate, tz)}</span>
                    </div>
                    <p className="text-slate-700">
                      {VALIDATION_LABEL[e.validation] ?? e.validation} · {e.workplaceName} · distance {fmtMeters(e.distanceMeters)} · accuracy ±{Math.round(e.accuracyMeters)} m
                    </p>
                    {e.evidence && (
                      <p className="text-xs text-slate-600">
                        Coordinates {e.evidence.lat.toFixed(6)}, {e.evidence.lng.toFixed(6)} ·{' '}
                        <a className="underline" target="_blank" rel="noreferrer" href={mapLinks(e.evidence.lat, e.evidence.lng).openStreetMap}>
                          map
                        </a>
                      </p>
                    )}
                    <p className="text-xs text-slate-500">Request {e.requestId}</p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-2 font-semibold text-navy-900">Approved adjustments</h3>
            {data.adjustments.length === 0 ? (
              <p className="text-slate-600">No adjustments.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.adjustments.map((a) => (
                  <li key={a.id} className="rounded-xl border border-navy-200 bg-navy-50 p-3">
                    <p className="font-semibold">
                      <Badge tone="info" icon="✎">Corrected</Badge> {ACTION_LABELS[a.action as AttendanceAction]}: {fmtPunch(a.before, workDate, tz)} → {a.after == null ? 'voided' : fmtPunch(a.after, workDate, tz)}
                    </p>
                    <p className="text-slate-700">Reason: {a.reason}</p>
                    <p className="text-xs text-slate-600">
                      By {a.reviewerName} on {fmtDateTime(a.createdAt, tz)}
                    </p>
                  </li>
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 className="mb-2 font-semibold text-navy-900">Requests</h3>
            {data.requests.length === 0 ? (
              <p className="text-slate-600">No requests for this date.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {data.requests.map((r) => (
                  <li key={r.id} className="rounded-xl border border-slate-200 p-3">
                    <p className="font-semibold">
                      {REQUEST_TYPE_LABELS[r.type as RequestType]} — {r.status}
                    </p>
                    <p className="text-slate-700">{r.explanation}</p>
                    {r.reviewerRemarks && <p className="text-xs text-slate-600">Reviewer: {r.reviewerRemarks}</p>}
                  </li>
                ))}
              </ul>
            )}
          </section>
          {canAdjust && (
            <Button variant="secondary" onClick={() => setAdjusting(true)}>
              Record an authorized adjustment
            </Button>
          )}
        </div>
      )}
      {adjusting && (
        <AdjustForm
          memberId={memberId}
          workDate={workDate}
          tz={tz}
          onClose={() => setAdjusting(false)}
          onDone={() => {
            setAdjusting(false);
            reload();
            onChanged?.();
          }}
        />
      )}
    </Modal>
  );
}

function AdjustForm({ memberId, workDate, tz, onClose, onDone }: { memberId: string; workDate: string; tz: string; onClose: () => void; onDone: () => void }) {
  const [action, setAction] = useState<AttendanceAction>('IN');
  const [when, setWhen] = useState(`${workDate}T08:00`);
  const [voidIt, setVoid] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  async function save() {
    setBusy(true);
    setError(null);
    try {
      const at = voidIt ? null : toUtc(when, tz);
      await callApi('adjustment.create', { memberId, workDate, action, at, reason });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open title="Authorized adjustment" onClose={onClose}>
      <div className="flex flex-col gap-3">
        <p className="text-sm text-slate-700">The original event stays unchanged. A separate adjustment is recorded with your name, the reason, and before/after values.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Action">
          {(id) => (
            <Select id={id} value={action} onChange={(e) => setAction(e.target.value as AttendanceAction)}>
              {(['IN', 'OUT', 'AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT'] as AttendanceAction[]).map((a) => (
                <option key={a} value={a}>
                  {ACTION_LABELS[a]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="checkbox" className="h-5 w-5" checked={voidIt} onChange={(e) => setVoid(e.target.checked)} /> Void this action (remove from computation)
        </label>
        {!voidIt && <Field label={`Corrected time (${tz})`}>{(id) => <Input id={id} type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} />}</Field>}
        <Field label="Reason (required)">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Button loading={busy} disabled={reason.trim().length < 5} onClick={save}>
          Save adjustment
        </Button>
        <p className="text-xs text-slate-500">Current device time in org timezone: {toLocalInput(Date.now(), tz)}</p>
      </div>
    </Modal>
  );
}

function toUtc(v: string, tz: string) {
  const [d, t] = v.split('T');
  const [h, m] = t.split(':').map(Number);
  return zonedToUtc(d, h * 60 + m, tz);
}
