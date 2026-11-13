import { collection, limit, onSnapshot, orderBy, query, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { addDays, localDate } from '../../../shared/time';
import { ACTION_LABELS, REQUEST_TYPE_LABELS, type AttendanceAction, type RequestType } from '../../../shared/types';
import { Alert, PageLoader, Badge, Button, Card, EmptyState, Field, Input, Modal, Pager, Select, Textarea, Toast, usePaged } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { db } from '../../firebase';
import { callApi } from '../../lib/api';
import { fmtDateShort, fmtDateTime } from '../../lib/format';
import { getFreshPosition } from '../../lib/geolocation';
import { mapLinks } from '../../../shared/geo';

/* eslint-disable @typescript-eslint/no-explicit-any */
export function RequestStatusBadge({ status }: { status: string }) {
  if (status === 'approved') return <Badge tone="success">Approved</Badge>;
  if (status === 'rejected') return <Badge tone="danger">Rejected</Badge>;
  if (status === 'cancelled') return <Badge tone="neutral">Cancelled</Badge>;
  return <Badge tone="warning" icon="…">Pending</Badge>;
}

export function RequestSummary({ r, tz }: { r: any; tz: string }) {
  return (
    <div className="text-sm text-slate-700">
      {r.action && (
        <p>
          {ACTION_LABELS[r.action as AttendanceAction]}: {r.currentAt ? `${fmtDateTime(r.currentAt, tz)} → ` : ''}
          <strong>{fmtDateTime(r.proposedAt, tz)}</strong>
        </p>
      )}
      {r.type === 'overtime' && <p>Planned overtime: up to {r.minutes} min</p>}
      {r.fieldwork && (
        <p>
          {r.type === 'wfh' || r.fieldwork.category === 'wfh' ? '🏠 ' : ''}
          {r.fieldwork.purpose} · {fmtDateTime(r.fieldwork.startAt, tz)} – {fmtDateTime(r.fieldwork.endAt, tz)} ·{' '}
          {r.fieldwork.mode === 'exemption' ? 'Location exemption' : `At ${r.fieldwork.locationName} (${r.fieldwork.radiusMeters} m)`}
          {r.fieldwork.mode !== 'exemption' && r.fieldwork.lat != null && (
            <>
              {' · '}
              <a className="underline" href={mapLinks(r.fieldwork.lat, r.fieldwork.lng).openStreetMap} target="_blank" rel="noreferrer">
                map
              </a>
            </>
          )}
        </p>
      )}
      <p className="mt-1 whitespace-pre-line">“{r.explanation}”</p>
      {r.reviewerRemarks && (
        <p className="mt-1 text-slate-600">
          Reviewer ({r.reviewerName}): {r.reviewerRemarks}
        </p>
      )}
    </div>
  );
}

export default function Requests() {
  const { orgId, user, tz, org } = useSession();
  const [items, setItems] = useState<any[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  useEffect(
    () =>
      onSnapshot(
        query(collection(db, 'organizations', orgId, 'correctionRequests'), where('memberId', '==', user.uid), orderBy('createdAt', 'desc'), limit(200)),
        (s) => setItems(s.docs.map((d) => ({ id: d.id, ...d.data() }))),
        (e) => setError(e.message),
      ),
    [orgId, user.uid],
  );
  const paged = usePaged(items ?? [], 10);
  async function cancel(id: string) {
    try {
      await callApi('request.cancel', { id });
      setToast('Request cancelled.');
    } catch (e) {
      setError((e as Error).message);
    }
  }
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between gap-2">
        <h1 className="text-2xl font-bold text-navy-900">Requests</h1>
        <Button variant="teal" onClick={() => setCreating(true)}>
          + New request
        </Button>
      </div>
      <p className="text-sm text-slate-600">Ask for a missing or incorrect entry to be corrected, explain an exception, request overtime approval, or request official business / fieldwork or work-from-home authorization. Requests take effect only after approval.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {!items && !error && <PageLoader />}
      {items && items.length === 0 && <EmptyState title="No requests yet" />}
      <ul className="flex flex-col gap-2">
        {paged.slice.map((r) => (
          <li key={r.id}>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="font-semibold text-navy-900">
                  {REQUEST_TYPE_LABELS[r.type as RequestType]} · {fmtDateShort(r.workDate)}
                </span>
                <RequestStatusBadge status={r.status} />
              </div>
              <RequestSummary r={r} tz={tz} />
              {r.status === 'pending' && (
                <Button variant="ghost" className="mt-2" onClick={() => cancel(r.id)}>
                  Cancel request
                </Button>
              )}
            </Card>
          </li>
        ))}
      </ul>
      <Pager {...paged} />
      {creating && <NewRequest tz={tz} wfhEnabled={org.settings.wfhEnabled} onClose={() => setCreating(false)} onDone={() => { setCreating(false); setToast('Request submitted for review.'); }} />}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function NewRequest({ tz, wfhEnabled, onClose, onDone }: { tz: string; wfhEnabled: boolean; onClose: () => void; onDone: () => void }) {
  const today = localDate(Date.now(), tz);
  const [type, setType] = useState<RequestType>('missing_punch');
  const [workDate, setWorkDate] = useState(today);
  const [action, setAction] = useState<AttendanceAction>('IN');
  const [proposedAt, setProposedAt] = useState(`${today}T08:00`);
  const [minutes, setMinutes] = useState(60);
  const [explanation, setExplanation] = useState('');
  const [fw, setFw] = useState({ startAt: `${today}T08:00`, endAt: `${today}T17:00`, mode: 'exemption' as 'exemption' | 'alternate_location', purpose: '', locationName: '', lat: '', lng: '', radiusMeters: '150' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);

  const remote = type === 'fieldwork' || type === 'wfh';
  const isWfh = type === 'wfh';
  function chooseType(t: RequestType) {
    setType(t);
    // Work from home defaults to pinning the home location rather than an exemption.
    if (t === 'wfh') setFw((f) => ({ ...f, mode: 'alternate_location', locationName: f.locationName || 'Home', purpose: f.purpose || 'Work from home', radiusMeters: f.radiusMeters || '100' }));
  }

  async function useHere() {
    setLocating(true);
    try {
      const r = await getFreshPosition();
      setFw((f) => ({ ...f, lat: r.lat.toFixed(6), lng: r.lng.toFixed(6) }));
    } catch {
      setError('Could not get your location. Enter the coordinates manually.');
    } finally {
      setLocating(false);
    }
  }

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const base = { type, workDate, explanation };
      let payload: Record<string, unknown> = base;
      if (type === 'missing_punch' || type === 'incorrect_punch') payload = { ...base, action, proposedAt };
      if (type === 'overtime') payload = { ...base, minutes: Number(minutes) };
      if (remote)
        payload = {
          ...base,
          fieldwork: {
            startAt: fw.startAt,
            endAt: fw.endAt,
            mode: fw.mode,
            purpose: fw.purpose,
            ...(fw.mode === 'alternate_location' ? { locationName: fw.locationName, lat: Number(fw.lat), lng: Number(fw.lng), radiusMeters: Number(fw.radiusMeters) } : {}),
          },
        };
      await callApi('request.submit', payload);
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Modal open title="New request" onClose={onClose}>
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Request type">
          {(id) => (
            <Select id={id} value={type} onChange={(e) => chooseType(e.target.value as RequestType)}>
              {(Object.keys(REQUEST_TYPE_LABELS) as RequestType[]).filter((t) => t !== 'wfh' || wfhEnabled).map((t) => (
                <option key={t} value={t}>
                  {REQUEST_TYPE_LABELS[t]}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Work date (shift date)" hint="For overnight shifts, use the date the shift started.">
          {(id) => <Input id={id} type="date" value={workDate} max={remote ? addDays(today, 60) : type === 'overtime' ? addDays(today, 31) : today} onChange={(e) => setWorkDate(e.target.value)} />}
        </Field>
        {(type === 'missing_punch' || type === 'incorrect_punch') && (
          <>
            <Field label="Attendance action">
              {(id) => (
                <Select id={id} value={action} onChange={(e) => setAction(e.target.value as AttendanceAction)}>
                  {(['IN', 'OUT', 'AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT', 'OT_IN', 'OT_OUT'] as AttendanceAction[]).map((a) => (
                    <option key={a} value={a}>
                      {ACTION_LABELS[a]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field label={`Proposed time (${tz})`}>{(id) => <Input id={id} type="datetime-local" value={proposedAt} onChange={(e) => setProposedAt(e.target.value)} />}</Field>
          </>
        )}
        {type === 'overtime' && (
          <>
            <Alert tone="info">
              File this <strong>before</strong> working overtime. Once filed — even while still pending — you can tap <strong>Overtime In</strong> after your regular Clock Out / PM Out, and <strong>Overtime Out</strong> when you finish. Overtime counts as approved only after your supervisor or HR approves, up to the minutes below.
            </Alert>
            <Field label="Planned overtime (minutes)" hint="e.g. 120 for 2 hours. Approved overtime is the time you clock, up to this amount.">
              {(id) => <Input id={id} type="number" min={1} max={720} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} />}
            </Field>
          </>
        )}
        {remote && (
          <>
            {isWfh && (
              <Alert tone="info">
                Pin your home location: while at home, tap “Use my current location”. During the approved period you can clock in only within the radius of that location.
              </Alert>
            )}
            <Field label={isWfh ? 'Work to be done' : 'Purpose'}>
              {(id) => <Input id={id} value={fw.purpose} onChange={(e) => setFw({ ...fw, purpose: e.target.value })} placeholder={isWfh ? 'e.g. Prepare monthly financial report' : 'e.g. Client audit at ABC Corp.'} />}
            </Field>
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
              <Field label="From">{(id) => <Input id={id} type="datetime-local" value={fw.startAt} onChange={(e) => setFw({ ...fw, startAt: e.target.value })} />}</Field>
              <Field label="Until">{(id) => <Input id={id} type="datetime-local" value={fw.endAt} onChange={(e) => setFw({ ...fw, endAt: e.target.value })} />}</Field>
            </div>
            <Field label="Location rule">
              {(id) => (
                <Select id={id} value={fw.mode} onChange={(e) => setFw({ ...fw, mode: e.target.value as typeof fw.mode })}>
                  <option value="alternate_location">{isWfh ? 'My home location (geofence at home)' : 'Alternate location (geofence at the site)'}</option>
                  <option value="exemption">Location exemption (no geofence; location still recorded)</option>
                </Select>
              )}
            </Field>
            {fw.mode === 'alternate_location' && (
              <>
                <Field label={isWfh ? 'Location label' : 'Site name'}>{(id) => <Input id={id} value={fw.locationName} onChange={(e) => setFw({ ...fw, locationName: e.target.value })} />}</Field>
                <div className="grid grid-cols-3 gap-2">
                  <Field label="Latitude">{(id) => <Input id={id} inputMode="decimal" value={fw.lat} onChange={(e) => setFw({ ...fw, lat: e.target.value })} />}</Field>
                  <Field label="Longitude">{(id) => <Input id={id} inputMode="decimal" value={fw.lng} onChange={(e) => setFw({ ...fw, lng: e.target.value })} />}</Field>
                  <Field label="Radius (m)">{(id) => <Input id={id} inputMode="numeric" value={fw.radiusMeters} onChange={(e) => setFw({ ...fw, radiusMeters: e.target.value })} />}</Field>
                </div>
                <Button variant="secondary" loading={locating} onClick={useHere}>
                  {isWfh ? 'Use my current location (I am at home)' : 'Use my current location'}
                </Button>
                {fw.lat && fw.lng && Number.isFinite(Number(fw.lat)) && Number.isFinite(Number(fw.lng)) && (
                  <a className="text-sm font-semibold text-brand-700 underline" href={mapLinks(Number(fw.lat), Number(fw.lng)).openStreetMap} target="_blank" rel="noreferrer">
                    Check this location on the map
                  </a>
                )}
              </>
            )}
          </>
        )}
        <Field label="Explanation" hint="Required. Your explanation is reviewed; it does not by itself record attendance.">
          {(id) => <Textarea id={id} value={explanation} onChange={(e) => setExplanation(e.target.value)} maxLength={1000} />}
        </Field>
        <Button variant="teal" loading={busy} disabled={explanation.trim().length < 5} onClick={submit}>
          Submit for approval
        </Button>
      </div>
    </Modal>
  );
}
