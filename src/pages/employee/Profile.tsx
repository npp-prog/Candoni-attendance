import { sendPasswordResetEmail } from 'firebase/auth';
import { collection, getDocs, query, where } from 'firebase/firestore';
import { useState } from 'react';
import { mapLinks } from '../../../shared/geo';
import { ROLE_LABELS } from '../../../shared/roles';
import { assignmentForDate } from '../../../shared/schedule';
import { localDate } from '../../../shared/time';
import type { ScheduleAssignmentDoc, WorkplaceDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, Modal, useAsync } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { auth, db } from '../../firebase';
import { detectPlatform } from '../../lib/geolocation';
import { callApi, type TodayData } from '../../lib/api';
import { PhoneRegistrationCard } from '../../components/PhoneRegistration';

export default function Profile() {
  const { member, org, orgId, departments, tz, logout, user } = useSession();
  const [notice, setNotice] = useState(false);
  const [info, setInfo] = useState<string | null>(null);
  const today = localDate(Date.now(), tz);
  const { data } = useAsync(async () => {
    const [as, wps, sch] = await Promise.all([
      getDocs(query(collection(db, 'organizations', orgId, 'scheduleAssignments'), where('memberId', '==', user.uid))),
      getDocs(query(collection(db, 'organizations', orgId, 'workplaces'), where('active', '==', true))),
      getDocs(collection(db, 'organizations', orgId, 'schedules')),
    ]);
    const assignments = as.docs.map((d) => ({ ...(d.data() as ScheduleAssignmentDoc), id: d.id }));
    const current = assignmentForDate(assignments, today);
    const schedules = Object.fromEntries(sch.docs.map((d) => [d.id, d.get('name') as string]));
    const workplaces = wps.docs
      .map((d) => ({ ...(d.data() as WorkplaceDoc), id: d.id }))
      .filter((w) => member.workplaceIds?.includes(w.id) || w.departmentIds?.includes(member.departmentId) || w.memberIds?.includes(member.uid));
    return { schedule: current ? schedules[current.scheduleId] : null, assignments, schedules, workplaces };
  }, [orgId, user.uid]);
  const platform = detectPlatform();
  const todayInfo = useAsync(() => callApi<TodayData>('me.today'), []);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">Profile</h1>
      <Card title={member.fullName} actions={<Badge tone="info">{ROLE_LABELS[member.role]}</Badge>}>
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-slate-600">Employee no.</dt>
          <dd>{member.employeeNumber}</dd>
          <dt className="text-slate-600">Email</dt>
          <dd className="break-all">{member.email}</dd>
          <dt className="text-slate-600">Department</dt>
          <dd>{departments[member.departmentId] ?? member.departmentId}</dd>
          <dt className="text-slate-600">Position</dt>
          <dd>{member.position || '—'}</dd>
          <dt className="text-slate-600">Classification</dt>
          <dd>{member.classification || '—'}</dd>
          <dt className="text-slate-600">Supervisor</dt>
          <dd>{member.supervisorName || '—'}</dd>
          <dt className="text-slate-600">Schedule</dt>
          <dd>{data?.schedule ?? 'None assigned'}</dd>
          <dt className="text-slate-600">Status</dt>
          <dd>{member.active ? 'Active' : 'Inactive'}</dd>
        </dl>
        <p className="mt-2 text-xs text-slate-500">Profile, schedule, and workplace assignments are managed by HR.</p>
      </Card>
      <Card title="Authorized workplaces">
        {data?.workplaces.length ? (
          <ul className="flex flex-col gap-2 text-sm">
            {data.workplaces.map((w) => (
              <li key={w.id} className="rounded-xl border border-slate-200 p-2">
                <p className="font-semibold">{w.name}</p>
                <p className="text-slate-600">{w.address}</p>
                <p className="text-slate-600">
                  Radius {w.radiusMeters} m ·{' '}
                  <a className="underline" href={mapLinks(w.lat, w.lng).openStreetMap} target="_blank" rel="noreferrer">
                    map
                  </a>
                </p>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-slate-600">No workplace assigned.</p>
        )}
      </Card>
      {todayInfo.data && <PhoneRegistrationCard device={todayInfo.data.device} onChanged={todayInfo.reload} />}
      <Card title="Install the app">
        {platform === 'ios' && <p className="text-sm text-slate-700">In Safari, tap the Share button, then “Add to Home Screen”.</p>}
        {platform === 'android' && <p className="text-sm text-slate-700">In Chrome, open the ⋮ menu and tap “Install app” or “Add to Home screen”.</p>}
        {platform === 'other' && <p className="text-sm text-slate-700">Use your browser’s “Install” or “Add to Home Screen” option.</p>}
        <p className="mt-1 text-xs text-slate-500">The installed app still needs an internet connection to record attendance.</p>
      </Card>
      <Card title="Privacy & security">
        <div className="flex flex-col gap-2">
          <Button variant="secondary" onClick={() => setNotice(true)}>
            View location privacy notice
          </Button>
          <Button
            variant="secondary"
            onClick={async () => {
              await sendPasswordResetEmail(auth, member.email).catch(() => undefined);
              setInfo('A password reset link was sent to your email.');
            }}
          >
            Change password
          </Button>
          {info && <Alert tone="success">{info}</Alert>}
          <Button variant="danger" onClick={logout}>
            Sign out
          </Button>
        </div>
      </Card>
      <Modal open={notice} onClose={() => setNotice(false)} title="Location privacy notice">
        <p className="whitespace-pre-line text-sm text-slate-800">{org.settings.privacyNoticeText}</p>
      </Modal>
    </div>
  );
}
