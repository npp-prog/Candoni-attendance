import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link } from 'react-router-dom';
import { actionSequence } from '../../../shared/attendance';
import { REJECTION_MESSAGES } from '../../../shared/errors';
import { evaluateGeofences, mapLinks, type GeofenceTarget } from '../../../shared/geo';
import { formatDateLong, localDate } from '../../../shared/time';
import { ACTION_LABELS, type AttendanceAction } from '../../../shared/types';
import { Alert, Badge, Button, Card, Modal, PageLoader, useOnline } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { attendanceStatus, callApi, clockAttendance, type ClockReceipt, type ClockRejection, type TodayData } from '../../lib/api';
import { fmtMeters, fmtPunch, fmtTime } from '../../lib/format';
import { detectPlatform, GEO_HELP, GeoError, geolocationSupport, getFreshPosition, permissionState, type GeoErrorKind, type Reading } from '../../lib/geolocation';
import { clearPending, loadPending, newRequestId, savePending, type PendingRequest } from '../../lib/pending';
import type { PublicKeyCredentialRequestOptionsJSON } from '@simplewebauthn/browser';
import { getDeviceHint, isFresh, passkeyErrorMessage, prepareVerification, verifyThisPhone, type Prepared } from '../../lib/device';
import { PhoneRegistrationCard } from '../../components/PhoneRegistration';

type Phase =
  | { k: 'idle' }
  | { k: 'explain'; action: AttendanceAction }
  | { k: 'locating'; action: AttendanceAction; requestId: string }
  | { k: 'review'; action: AttendanceAction; requestId: string; reading: Reading; deviceError?: string }
  | { k: 'submitting'; action: AttendanceAction; requestId: string }
  | { k: 'uncertain'; pending: PendingRequest; checking: boolean; note?: string }
  | { k: 'receipt'; receipt: ClockReceipt }
  | { k: 'rejected'; action: AttendanceAction; rejection: ClockRejection }
  | { k: 'geoerror'; action: AttendanceAction; kind: GeoErrorKind; requestId: string };

function useOrgClock(serverTime: number | undefined) {
  const offset = useRef(0);
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (serverTime) offset.current = serverTime - Date.now();
  }, [serverTime]);
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);
  return now + offset.current;
}

export default function Home() {
  const { member, departments, tz, user } = useSession();
  const online = useOnline();
  const [data, setData] = useState<TodayData | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>({ k: 'idle' });
  const orgNow = useOrgClock(data?.serverTime);

  const load = useCallback(async () => {
    try {
      setLoadError(null);
      setData(await callApi<TodayData>('me.today'));
    } catch (e) {
      setLoadError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    load();
    const t = setInterval(load, 60_000);
    const onVis = () => document.visibilityState === 'visible' && load();
    document.addEventListener('visibilitychange', onVis);
    return () => {
      clearInterval(t);
      document.removeEventListener('visibilitychange', onVis);
    };
  }, [load]);

  // Resume an unconfirmed request from a previous network failure.
  const checkPending = useCallback(
    async (pending: PendingRequest) => {
      setPhase({ k: 'uncertain', pending, checking: true });
      try {
        const r = await attendanceStatus(pending.requestId);
        if (r.found && r.receipt) {
          clearPending(user.uid);
          setPhase({ k: 'receipt', receipt: r.receipt });
          load();
        } else {
          setPhase({ k: 'uncertain', pending, checking: false, note: 'The server has no record of this request. It was not recorded. You can retry it safely.' });
        }
      } catch {
        setPhase({ k: 'uncertain', pending, checking: false, note: 'Still unable to reach the server. Check your connection and try again.' });
      }
    },
    [user.uid, load],
  );
  useEffect(() => {
    const p = loadPending(user.uid);
    if (p) checkPending(p);
  }, [user.uid, checkPending]);

  const targets: GeofenceTarget[] = useMemo(() => {
    if (!data) return [];
    return [
      ...data.workplaces.map((w) => ({ id: w.id, name: w.name, lat: w.lat, lng: w.lng, radiusMeters: w.radiusMeters })),
      ...data.fieldwork
        .filter((f) => f.mode === 'alternate_location' && f.lat != null && f.lng != null && f.radiusMeters)
        .map((f) => ({ id: `fw:${f.id}`, name: f.category === 'wfh' ? `Work from home${f.locationName ? ` (${f.locationName})` : ''}` : f.locationName ?? 'Fieldwork location', lat: f.lat!, lng: f.lng!, radiusMeters: f.radiusMeters! })),
    ];
  }, [data]);
  const exemption = data?.fieldwork.find((f) => f.mode === 'exemption');

  // Registered-phone challenge, fetched before the Submit tap so the phone's
  // fingerprint/face prompt can start directly from that tap (needed on iOS).
  const [prepared, setPrepared] = useState<Prepared<PublicKeyCredentialRequestOptionsJSON> | null>(null);
  const deviceRequired = !!data?.device.required;

  async function locate(action: AttendanceAction, requestId: string) {
    setPhase({ k: 'locating', action, requestId });
    try {
      const [reading] = await Promise.all([
        getFreshPosition(20_000),
        deviceRequired ? prepareVerification().then(setPrepared, () => setPrepared(null)) : Promise.resolve(),
      ]);
      setPhase({ k: 'review', action, requestId, reading });
    } catch (e) {
      setPhase({ k: 'geoerror', action, kind: e instanceof GeoError ? e.kind : 'unavailable', requestId });
    }
  }

  async function start(action: AttendanceAction) {
    const support = geolocationSupport();
    if (support !== 'ok') return setPhase({ k: 'geoerror', action, kind: support, requestId: newRequestId() });
    const state = await permissionState();
    if (state === 'denied') return setPhase({ k: 'geoerror', action, kind: 'denied', requestId: newRequestId() });
    // Always explain before the first browser prompt; skip once permission is granted.
    if (state !== 'granted') return setPhase({ k: 'explain', action });
    locate(action, newRequestId());
  }

  async function submit(action: AttendanceAction, requestId: string, reading: Reading) {
    let deviceAssertion: unknown;
    if (deviceRequired) {
      if (!prepared || !isFresh(prepared)) {
        setPrepared(null);
        prepareVerification().then(setPrepared, () => undefined);
        return setPhase({ k: 'review', action, requestId, reading, deviceError: 'Phone check expired. Tap Submit again.' });
      }
      try {
        // Started directly from the tap: shows the phone's fingerprint/face/PIN prompt.
        deviceAssertion = await verifyThisPhone(prepared);
      } catch (e) {
        setPrepared(null);
        prepareVerification().then(setPrepared, () => undefined);
        return setPhase({ k: 'review', action, requestId, reading, deviceError: passkeyErrorMessage(e) });
      }
      setPrepared(null); // single use
    }
    const pending: PendingRequest = { requestId, action, startedAt: Date.now() };
    savePending(user.uid, pending);
    setPhase({ k: 'submitting', action, requestId });
    try {
      const res = await clockAttendance({ requestId, action, location: { ...reading, sentAt: Date.now() }, deviceHint: getDeviceHint(), deviceAssertion });
      clearPending(user.uid);
      if (res.ok) setPhase({ k: 'receipt', receipt: res });
      else setPhase({ k: 'rejected', action, rejection: res });
      load();
    } catch (e) {
      const err = e as { uncertain?: boolean; message: string };
      if (err.uncertain) {
        setPhase({ k: 'uncertain', pending, checking: false, note: 'We could not confirm whether the server received your request. Nothing is shown as recorded until the server confirms it.' });
      } else {
        clearPending(user.uid);
        setPhase({ k: 'rejected', action, rejection: { ok: false, code: 'INVALID_REQUEST', message: err.message } });
      }
    }
  }

  if (!data && !loadError) return <PageLoader label="Loading today…" />;

  const next = data?.next;
  const plan = data?.plan;
  const baseSeq = plan ? actionSequence(plan.unscheduled ? 'single' : plan.pattern) : [];
  // Overtime In/Out appear once overtime is offered or recorded.
  const showOt = !!data && (data.punches.OT_IN != null || next?.action === 'OT_IN' || next?.action === 'OT_OUT' || !!next?.altActions?.includes('OT_IN'));
  const seq = showOt ? [...baseSeq, 'OT_IN' as const, 'OT_OUT' as const] : baseSeq;
  const busy = ['locating', 'submitting', 'explain', 'review'].includes(phase.k);
  const phoneBlocked = !!data && data.device.required && data.device.status !== 'active';
  const canAct = online && !!next?.action && next.code === 'OK' && phase.k !== 'uncertain' && !phoneBlocked;

  return (
    <div className="flex flex-col gap-4">
      <div>
        <p className="text-sm text-slate-600">Good day,</p>
        <h1 className="text-2xl font-bold text-navy-900">{member.fullName}</h1>
        <p className="text-sm text-slate-600">
          {departments[member.departmentId] ?? member.departmentId} · {member.position}
        </p>
      </div>

      <section className="rounded-2xl bg-navy-900 p-4 text-white shadow-sm">
        <p className="text-sm text-navy-100">{formatDateLong(localDate(orgNow, tz))}</p>
        <p className="tabular text-4xl font-bold tracking-tight" aria-live="off">
          {new Intl.DateTimeFormat('en-PH', { timeZone: tz, hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true }).format(orgNow)}
        </p>
        <p className="mt-1 text-xs text-navy-100">Organization time ({tz}). Official times are set by the server.</p>
      </section>

      {loadError && (
        <Alert tone="danger" title="Could not load today’s status">
          {loadError}{' '}
          <button className="font-semibold underline" onClick={load}>
            Retry
          </button>
        </Alert>
      )}
      {!online && (
        <Alert tone="warning" title="You are offline">
          Attendance needs an internet connection and is never saved for later. Reconnect and try again. If you could not record attendance, submit a{' '}
          <Link className="font-semibold underline" to="/requests">
            correction request
          </Link>{' '}
          once you are back online.
        </Alert>
      )}

      {data && plan && next && (
        <>
          <Card title="Today’s schedule" actions={<ScheduleBadge data={data} />}>
            <ScheduleText data={data} />
            <ul className="mt-3 grid grid-cols-2 gap-2">
              {seq.map((a) => (
                <li key={a} className="rounded-xl border border-slate-200 p-2">
                  <p className="text-xs font-medium text-slate-600">{ACTION_LABELS[a]}</p>
                  <p className="tabular text-lg font-semibold text-navy-900">{fmtPunch(data.punches[a], next.workDate, tz)}</p>
                  {data.correctedActions.includes(a) && <Badge tone="info" icon="✎">Corrected</Badge>}
                  {data.punches[a] == null && <p className="text-xs text-slate-500">Not recorded</p>}
                </li>
              ))}
            </ul>
            {next.workDate !== data.today && (
              <p className="mt-2 text-xs text-slate-600">This shift belongs to work date {next.workDate} (overnight shift).</p>
            )}
          </Card>

          <div className="flex flex-col gap-2">
            <Button
              variant="teal"
              className="min-h-20 w-full rounded-2xl text-2xl shadow-lg"
              disabled={!canAct || busy}
              onClick={() => next.action && start(next.action)}
              aria-describedby="action-reason"
            >
              {next.action ? ACTION_LABELS[next.action] : 'No action available'}
            </Button>
            {(next.altActions ?? []).map((alt) => (
              <Button key={alt} variant="secondary" className="min-h-14 w-full rounded-2xl text-lg" disabled={!canAct || busy} onClick={() => start(alt)}>
                {ACTION_LABELS[alt]} instead
              </Button>
            ))}
            {(next.altActions ?? []).includes('OT_IN') && (
              <p className="text-center text-xs text-slate-600">You have a filed overtime request for this day. Use “Overtime In” only for overtime outside your regular hours.</p>
            )}
            <p id="action-reason" className="text-center text-sm text-slate-700">
              {phoneBlocked && (data.device.status === 'pending' ? 'Your registered phone is waiting for HR approval.' : 'Register this phone below before clocking in.')}
              {!phoneBlocked && next.code === 'OK' && (deviceRequired ? 'You will confirm with your phone’s fingerprint, face or PIN. Location is checked only when you tap.' : 'Your location is checked only when you tap the button.')}
              {next.code !== 'OK' && next.message}
              {next.availableAt && next.code !== 'OK' && <> Available at {fmtTime(next.availableAt, tz)}.</>}
            </p>
          </div>

          {phoneBlocked && <PhoneRegistrationCard device={data.device} onChanged={load} compact />}
          <LocationCard data={data} exemption={!!exemption} />
        </>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Link to="/history" className="flex min-h-14 items-center justify-center rounded-2xl border border-slate-300 bg-white font-semibold text-navy-900">
          Attendance history
        </Link>
        <Link to="/requests" className="flex min-h-14 items-center justify-center rounded-2xl border border-slate-300 bg-white font-semibold text-navy-900">
          Corrections & fieldwork
        </Link>
      </div>

      <PhaseModal
        phase={phase}
        tz={tz}
        data={data}
        targets={targets}
        exemption={!!exemption}
        onClose={() => setPhase({ k: 'idle' })}
        onLocate={locate}
        onSubmit={submit}
        onRetryFresh={(action) => locate(action, newRequestId())}
        onCheck={checkPending}
      />
    </div>
  );
}

function ScheduleBadge({ data }: { data: TodayData }) {
  const k = data.plan.kind;
  if (data.plan.unscheduled && k === 'workday') return <Badge tone="warning">Unscheduled</Badge>;
  if (k === 'holiday') return <Badge icon="★">Holiday</Badge>;
  if (k === 'rest_day') return <Badge icon="☾">Rest day</Badge>;
  if (k === 'no_schedule') return <Badge tone="warning">No schedule</Badge>;
  return <Badge tone="info">{data.plan.pattern === 'split' ? 'AM / PM' : 'Regular'}</Badge>;
}

function ScheduleText({ data }: { data: TodayData }) {
  const { plan, timezone: tz } = data;
  if (plan.kind === 'holiday') return <p className="text-slate-700">{plan.holidayName}. Attendance is not expected.</p>;
  if (plan.kind === 'rest_day') return <p className="text-slate-700">Rest day. Attendance is not expected.</p>;
  if (plan.kind === 'no_schedule') return <p className="text-slate-700">No schedule is assigned. Contact HR if this is wrong.</p>;
  return (
    <div className="text-slate-800">
      <p className="font-semibold">{plan.scheduleName ?? data.scheduleName}</p>
      <p className="tabular">
        {plan.sessions.map((s, i) => (
          <span key={i}>
            {i > 0 && ' · '}
            {fmtTime(s.start, tz)} – {fmtPunch(s.end, plan.workDate, tz)}
          </span>
        ))}
      </p>
      <p className="text-xs text-slate-600">
        Grace period {plan.graceMinutes} min{plan.flexible ? ` · flexible start up to ${plan.flexMinutes} min` : ''}
      </p>
    </div>
  );
}

function LocationCard({ data, exemption }: { data: TodayData; exemption: boolean }) {
  return (
    <Card title="Location verification">
      {data.workplaces.length === 0 && data.fieldwork.length === 0 ? (
        <Alert tone="warning" title="No authorized workplace">
          You have no workplace assigned, so attendance cannot be accepted. Contact HR or request fieldwork or work-from-home authorization.
        </Alert>
      ) : (
        <ul className="flex flex-col gap-1 text-sm text-slate-700">
          {data.workplaces.map((w) => (
            <li key={w.id}>
              📍 <span className="font-medium">{w.name}</span> — within {w.radiusMeters} m
            </li>
          ))}
          {data.fieldwork.map((f) => (
            <li key={f.id}>
              {f.category === 'wfh' ? '🏠 Approved work from home' : '⚑ Approved fieldwork'}: <span className="font-medium">{f.purpose}</span>
              {f.mode === 'exemption' ? ' (location exemption)' : ` at ${f.locationName}`} until {fmtTime(f.endAt, data.timezone)}
            </li>
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-600">
        Readings must be accurate to {data.limits.maxAccuracyMeters} m and less than {data.limits.maxLocationAgeSeconds} s old.
        {exemption && ' An approved exemption is active; your location is still recorded as evidence.'}
      </p>
    </Card>
  );
}

interface PhaseProps {
  phase: Phase;
  tz: string;
  data: TodayData | null;
  targets: GeofenceTarget[];
  exemption: boolean;
  onClose: () => void;
  onLocate: (a: AttendanceAction, requestId: string) => void;
  onSubmit: (a: AttendanceAction, requestId: string, r: Reading) => void;
  onRetryFresh: (a: AttendanceAction) => void;
  onCheck: (p: PendingRequest) => void;
}

function PhaseModal({ phase, tz, data, targets, exemption, onClose, onLocate, onSubmit, onRetryFresh, onCheck }: PhaseProps) {
  const platform = detectPlatform();
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (phase.k !== 'review') return;
    const t = setInterval(() => setTick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, [phase.k]);
  void tick;
  const blocking = phase.k === 'submitting' || phase.k === 'locating';
  const close = blocking ? () => undefined : onClose;

  switch (phase.k) {
    case 'idle':
      return null;
    case 'explain':
      return (
        <Modal open title="Location needed" onClose={close}>
          <div className="flex flex-col gap-3 text-slate-800">
            <p>
              To record <strong>{ACTION_LABELS[phase.action]}</strong>, the app needs your current location once, right now. It checks that you are within an authorized workplace area.
            </p>
            <ul className="list-disc pl-5 text-sm text-slate-700">
              <li>Collected only when you tap an attendance action.</li>
              <li>No continuous or background tracking.</li>
              <li>Your browser will ask for permission — choose “Allow”.</li>
            </ul>
            <Button variant="teal" className="min-h-14 text-lg" onClick={() => onLocate(phase.action, newRequestId())}>
              Continue
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </Modal>
      );
    case 'locating':
      return (
        <Modal open title="Getting your location…" onClose={close}>
          <div className="flex flex-col items-center gap-3 py-6 text-center text-navy-800">
            <span className="h-10 w-10 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" aria-hidden />
            <p role="status">Requesting a fresh, high-accuracy position. Stay still for a moment.</p>
          </div>
        </Modal>
      );
    case 'review': {
      const { reading, action, requestId, deviceError } = phase;
      const limits = data?.limits ?? { maxAccuracyMeters: 100, maxLocationAgeSeconds: 60 };
      const age = Math.max(0, Math.round((Date.now() - reading.capturedAt) / 1000));
      const stale = age > limits.maxLocationAgeSeconds - 5;
      const inaccurate = reading.accuracy > limits.maxAccuracyMeters;
      const { nearest, match } = evaluateGeofences(reading.lat, reading.lng, targets);
      const inside = !!match || exemption;
      const ok = !stale && !inaccurate && inside;
      return (
        <Modal open title={`Confirm ${ACTION_LABELS[action]}`} onClose={close}>
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-2 gap-2 text-sm">
              <div className="rounded-xl bg-slate-50 p-2">
                <dt className="text-slate-600">Reported accuracy</dt>
                <dd className="tabular text-lg font-semibold">±{Math.round(reading.accuracy)} m</dd>
                <dd>{inaccurate ? <Badge tone="danger">Too imprecise</Badge> : <Badge tone="success">OK</Badge>}</dd>
              </div>
              <div className="rounded-xl bg-slate-50 p-2">
                <dt className="text-slate-600">{match ? match.target.name : nearest ? `Nearest: ${nearest.target.name}` : 'Workplace'}</dt>
                <dd className="tabular text-lg font-semibold">{fmtMeters((match ?? nearest)?.distanceMeters)}</dd>
                <dd>
                  {match ? (
                    <Badge tone="success">Inside {match.target.radiusMeters} m</Badge>
                  ) : exemption ? (
                    <Badge tone="info" icon="⚑">Exemption</Badge>
                  ) : nearest ? (
                    <Badge tone="danger">Outside {nearest.target.radiusMeters} m</Badge>
                  ) : (
                    <Badge tone="danger">None assigned</Badge>
                  )}
                </dd>
              </div>
            </dl>
            <p className="text-xs text-slate-600">
              Reading taken {age}s ago. <a className="underline" href={mapLinks(reading.lat, reading.lng).openStreetMap} target="_blank" rel="noreferrer">View on map</a>
            </p>
            {inaccurate && <Alert tone="warning">{REJECTION_MESSAGES.LOCATION_INACCURATE}</Alert>}
            {stale && <Alert tone="warning">This reading is too old. Retry to capture a fresh position.</Alert>}
            {!inside && !inaccurate && (
              <Alert tone="warning" title="Outside your authorized area">
                Move closer to your workplace and retry. If you are on official business, submit a{' '}
                <Link className="font-semibold underline" to="/requests">
                  fieldwork or work-from-home request
                </Link>
                .
              </Alert>
            )}
            <Button variant="teal" className="min-h-14 text-lg" disabled={!ok} onClick={() => onSubmit(action, requestId, reading)}>
              {data?.device.required ? `Confirm & submit ${ACTION_LABELS[action]}` : `Submit ${ACTION_LABELS[action]}`}
            </Button>
            {data?.device.required && <p className="text-xs text-slate-600">Your phone will ask for its fingerprint, face or PIN.</p>}
            {deviceError && <Alert tone="warning">{deviceError}</Alert>}
            <Button variant="secondary" onClick={() => onRetryFresh(action)}>
              Retry location
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
        </Modal>
      );
    }
    case 'submitting':
      return (
        <Modal open title="Submitting…" onClose={close}>
          <div className="flex flex-col items-center gap-3 py-6 text-center text-navy-800">
            <span className="h-10 w-10 animate-spin rounded-full border-4 border-brand-500 border-t-transparent" aria-hidden />
            <p role="status">Sending to the server for validation. Please keep this screen open.</p>
          </div>
        </Modal>
      );
    case 'uncertain':
      return (
        <Modal open title="Not yet confirmed" onClose={close}>
          <div className="flex flex-col gap-3">
            <Alert tone="warning" title={`${ACTION_LABELS[phase.pending.action]} is not confirmed`}>
              {phase.note ?? 'Checking with the server…'}
            </Alert>
            <p className="text-xs text-slate-600">Request ID: {phase.pending.requestId}</p>
            <Button loading={phase.checking} onClick={() => onCheck(phase.pending)}>
              Check status
            </Button>
            <Button variant="teal" disabled={phase.checking} onClick={() => onLocate(phase.pending.action, phase.pending.requestId)}>
              Retry same request
            </Button>
            <p className="text-xs text-slate-600">Retrying reuses the same request ID, so it can never create a duplicate record.</p>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </Modal>
      );
    case 'receipt': {
      const r = phase.receipt;
      return (
        <Modal open title="Attendance recorded" onClose={close}>
          <div className="flex flex-col gap-3">
            <div className="rounded-2xl border-2 border-emerald-300 bg-emerald-50 p-4 text-center">
              <p className="text-3xl" aria-hidden>
                ✓
              </p>
              <p className="text-lg font-bold text-emerald-900">{ACTION_LABELS[r.action]} accepted</p>
              <p className="tabular text-3xl font-bold text-navy-900">{fmtTime(r.at, r.timezone)}</p>
              <p className="text-sm text-slate-700">{formatDateLong(localDate(r.at, r.timezone))}</p>
            </div>
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
              <dt className="text-slate-600">Work date</dt>
              <dd>{r.workDate}</dd>
              <dt className="text-slate-600">Location</dt>
              <dd>{r.workplaceName}</dd>
              <dt className="text-slate-600">Distance</dt>
              <dd>{fmtMeters(r.distanceMeters)}</dd>
              <dt className="text-slate-600">Accuracy</dt>
              <dd>±{Math.round(r.accuracyMeters)} m</dd>
              <dt className="text-slate-600">Receipt</dt>
              <dd className="break-all font-mono text-xs">{r.eventId.split('_').pop()}</dd>
            </dl>
            {r.replayed && <Alert tone="info">This request had already been recorded; showing the original receipt.</Alert>}
            {r.deviceVerified && <p className="text-sm text-emerald-800">✓ Confirmed on your registered phone</p>}
            <p className="text-xs text-slate-600">Official server time, shown in {tz}.</p>
            <Button onClick={onClose}>Done</Button>
          </div>
        </Modal>
      );
    }
    case 'rejected': {
      const { rejection, action } = phase;
      const retryable = ['LOCATION_INACCURATE', 'LOCATION_STALE', 'OUTSIDE_GEOFENCE', 'LOCATION_INVALID', 'LOCATION_MISSING', 'LOCATION_FROM_FUTURE', 'RATE_LIMITED', 'INVALID_REQUEST', 'CONFLICT'].includes(rejection.code);
      return (
        <Modal open title="Attendance not recorded" onClose={close}>
          <div className="flex flex-col gap-3">
            <Alert tone="danger" title={rejection.message} />
            <p className="text-xs text-slate-600">Reason code: {rejection.code}</p>
            {['OUTSIDE_GEOFENCE', 'NO_AUTHORIZED_WORKPLACE', 'SHIFT_CLOSED'].includes(rejection.code) && (
              <p className="text-sm text-slate-700">
                If you are working elsewhere on official business or missed an entry, submit a{' '}
                <Link to="/requests" className="font-semibold underline">
                  correction or fieldwork request
                </Link>
                . An explanation alone does not record attendance; it must be approved.
              </p>
            )}
            {retryable && (
              <Button variant="teal" onClick={() => onRetryFresh(action)}>
                Retry with a fresh location
              </Button>
            )}
            <Button variant="secondary" onClick={onClose}>
              Close
            </Button>
          </div>
        </Modal>
      );
    }
    case 'geoerror': {
      const help = GEO_HELP[phase.kind];
      return (
        <Modal open title={help.title} onClose={close}>
          <div className="flex flex-col gap-3">
            <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-800">
              {help.steps[platform].map((s) => (
                <li key={s}>{s}</li>
              ))}
            </ol>
            {phase.kind !== 'unsupported' && phase.kind !== 'insecure' && (
              <Button variant="teal" onClick={() => onLocate(phase.action, phase.requestId)}>
                Retry
              </Button>
            )}
            <p className="text-sm text-slate-700">
              Still not working? Submit a{' '}
              <Link to="/requests" className="font-semibold underline">
                correction request
              </Link>{' '}
              with an explanation.
            </p>
            <Button variant="ghost" onClick={onClose}>
              Close
            </Button>
          </div>
        </Modal>
      );
    }
  }
}
