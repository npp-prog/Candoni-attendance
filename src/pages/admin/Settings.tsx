import { useState } from 'react';
import { isSysAdmin } from '../../../shared/roles';
import { addDays, isValidTimeZone, localDate } from '../../../shared/time';
import type { OrgSettings } from '../../../shared/types';
import { BrandMark } from '../../components/Brand';
import { Alert, Button, Card, Field, Input, Select, Textarea, Toast } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';

export default function Settings() {
  const { member } = useSession();
  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-bold text-navy-900">{isSysAdmin(member.role) ? 'Organization settings' : 'Maintenance'}</h1>
      {isSysAdmin(member.role) ? <OrgSettingsForm /> : <Alert tone="info">Organization settings are managed by system administrators.</Alert>}
      <Maintenance />
    </div>
  );
}

function OrgSettingsForm() {
  const { org } = useSession();
  const [name, setName] = useState(org.name);
  const [shortName, setShortName] = useState(org.shortName);
  const [logoUrl, setLogoUrl] = useState<string | null>(org.logoUrl);
  const [s, setS] = useState<OrgSettings>(org.settings);
  const [bumpNotice, setBumpNotice] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const noticeChanged = s.privacyNoticeText !== org.settings.privacyNoticeText;

  function onLogo(file: File | undefined) {
    if (!file) return;
    if (file.size > 200_000) return setError('Logo must be smaller than 200 KB. Use a compressed PNG, WebP or SVG.');
    const r = new FileReader();
    r.onload = () => setLogoUrl(String(r.result));
    r.readAsDataURL(file);
  }
  async function save() {
    setBusy(true);
    setError(null);
    try {
      if (!isValidTimeZone(s.timezone)) throw new Error('Unknown timezone. Use an IANA name such as Asia/Manila.');
      const settings = { ...s, privacyNoticeVersion: org.settings.privacyNoticeVersion + (bumpNotice || noticeChanged ? 1 : 0) };
      await callApi('settings.update', { name, shortName, logoUrl: logoUrl || null, settings });
      setToast(bumpNotice || noticeChanged ? 'Saved. Employees will be asked to review the updated privacy notice.' : 'Settings saved.');
      setBumpNotice(false);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const num = (k: keyof OrgSettings, label: string, hint: string, min: number, max: number) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" min={min} max={max} value={s[k] as number} onChange={(e) => setS({ ...s, [k]: Number(e.target.value) })} />}
    </Field>
  );

  return (
    <>
      {error && <Alert tone="danger">{error}</Alert>}
      <Card title="Branding">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Organization name">{(id) => <Input id={id} value={name} onChange={(e) => setName(e.target.value)} />}</Field>
          <Field label="Short name">{(id) => <Input id={id} value={shortName} onChange={(e) => setShortName(e.target.value)} />}</Field>
          <Field label="Logo URL (https) or upload" hint="Shown on sign-in, header and printed records.">
            {(id) => <Input id={id} value={logoUrl?.startsWith('data:') ? '(uploaded image)' : logoUrl ?? ''} onChange={(e) => setLogoUrl(e.target.value || null)} placeholder="https://…" />}
          </Field>
          <Field label="Upload logo (≤200 KB)">{(id) => <Input id={id} type="file" accept="image/png,image/jpeg,image/webp,image/svg+xml" onChange={(e) => onLogo(e.target.files?.[0])} />}</Field>
        </div>
        <div className="mt-3 flex items-center gap-3">
          {logoUrl ? <img src={logoUrl} alt="Logo preview" className="h-12 w-12 rounded-xl object-contain" /> : <BrandMark size={48} />}
          {logoUrl && (
            <Button variant="ghost" onClick={() => setLogoUrl(null)}>
              Use default mark
            </Button>
          )}
        </div>
      </Card>
      <Card title="Attendance policy">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Organization timezone" hint="IANA name, e.g. Asia/Manila. Times are stored in UTC.">
            {(id) => <Input id={id} value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })} />}
          </Field>
          {num('maxAccuracyMeters', 'Maximum location accuracy (m)', 'Readings less precise than this must be retried. Does not enlarge geofences.', 5, 1000)}
          {num('maxLocationAgeSeconds', 'Maximum location age (s)', 'Older readings must be retried.', 10, 600)}
          {num('minActionIntervalSeconds', 'Minimum seconds between actions', 'Prevents accidental double taps.', 10, 3600)}
          {num('unscheduledMaxHours', 'Unscheduled shift limit (h)', 'Clock-out window for rest-day/holiday work.', 1, 24)}
          <Field label="Approval workflow">
            {(id) => (
              <Select id={id} value={s.approvalMode} onChange={(e) => setS({ ...s, approvalMode: e.target.value as OrgSettings['approvalMode'] })}>
                <option value="supervisor_or_hr">Department supervisor or HR</option>
                <option value="hr_only">HR only</option>
              </Select>
            )}
          </Field>
        </div>
        <label className="mt-3 flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={s.allowUnscheduledAttendance} onChange={(e) => setS({ ...s, allowUnscheduledAttendance: e.target.checked })} />
          Allow attendance on rest days, holidays, or without a schedule (flagged as unscheduled)
        </label>
      </Card>
      <Card title="Location privacy notice">
        <Textarea className="min-h-64" value={s.privacyNoticeText} onChange={(e) => setS({ ...s, privacyNoticeText: e.target.value })} aria-label="Privacy notice text" />
        <p className="mt-1 text-xs text-slate-600">Current version {org.settings.privacyNoticeVersion}. Changing the text publishes a new version that every employee must acknowledge.</p>
        <label className="mt-2 flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={bumpNotice} onChange={(e) => setBumpNotice(e.target.checked)} /> Require re-acknowledgement even without text changes
        </label>
      </Card>
      <Card title="Retention">
        <Alert tone="warning">Destructive deletion is disabled unless you enable it here. Accepted attendance events, adjustments and audit logs are never deleted automatically.</Alert>
        <label className="mt-2 flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={s.retention.enabled} onChange={(e) => setS({ ...s, retention: { ...s.retention, enabled: e.target.checked } })} />
          Enable scheduled deletion
        </label>
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <Field label="Delete rejected attempts after (days)">{(id) => <Input id={id} type="number" min={30} value={s.retention.rejectedAttemptDays} onChange={(e) => setS({ ...s, retention: { ...s.retention, rejectedAttemptDays: Number(e.target.value) } })} />}</Field>
          <Field label="Delete precise location evidence after (days)">{(id) => <Input id={id} type="number" min={90} value={s.retention.locationEvidenceDays} onChange={(e) => setS({ ...s, retention: { ...s.retention, locationEvidenceDays: Number(e.target.value) } })} />}</Field>
        </div>
      </Card>
      <Button loading={busy} onClick={save} className="self-start">
        Save settings
      </Button>
      <Toast message={toast} onDone={() => setToast(null)} />
    </>
  );
}

function Maintenance() {
  const { tz } = useSession();
  const today = localDate(Date.now(), tz);
  const [from, setFrom] = useState(addDays(today, -31));
  const [to, setTo] = useState(today);
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<{ checked: number; changed: number; drift: string[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  return (
    <Card title="Rebuild attendance summaries">
      <p className="text-sm text-slate-600">Recomputes shift summaries from the immutable attendance events and approved adjustments, and reports any records that had drifted.</p>
      {error && <Alert tone="danger" className="mt-2">{error}</Alert>}
      <div className="mt-2 grid grid-cols-1 gap-2 sm:grid-cols-3">
        <Field label="From">{(id) => <Input id={id} type="date" value={from} onChange={(e) => setFrom(e.target.value)} />}</Field>
        <Field label="To">{(id) => <Input id={id} type="date" value={to} onChange={(e) => setTo(e.target.value)} />}</Field>
        <div className="flex items-end">
          <Button
            className="w-full"
            loading={busy}
            onClick={async () => {
              setBusy(true);
              setError(null);
              try {
                setResult(await callApi('summaries.rebuild', { from, to }));
              } catch (e) {
                setError((e as Error).message);
              } finally {
                setBusy(false);
              }
            }}
          >
            Rebuild
          </Button>
        </div>
      </div>
      {result && (
        <Alert tone={result.changed ? 'warning' : 'success'} className="mt-2">
          Checked {result.checked} shift(s); {result.changed} needed rebuilding.{result.drift.length > 0 && ` Examples: ${result.drift.slice(0, 5).join(', ')}`}
        </Alert>
      )}
    </Card>
  );
}
