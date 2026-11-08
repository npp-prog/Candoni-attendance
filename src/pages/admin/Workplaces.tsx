import { useState } from 'react';
import { mapLinks } from '../../../shared/geo';
import type { WorkplaceDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Textarea, Toast } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { getFreshPosition } from '../../lib/geolocation';
import { useCollection } from '../../lib/hooks';

type Form = { id?: string; name: string; address: string; lat: string; lng: string; radiusMeters: string; active: boolean; departmentIds: string[]; memberIds: string[] };

export default function Workplaces() {
  const { orgId, departments } = useSession();
  const { items, error } = useCollection<WorkplaceDoc>(['organizations', orgId, 'workplaces']);
  const [form, setForm] = useState<Form | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const list = [...(items ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy-900">Workplaces & geofences</h1>
        <Button variant="teal" onClick={() => setForm({ name: '', address: '', lat: '', lng: '', radiusMeters: '100', active: true, departmentIds: [], memberIds: [] })}>
          + Add workplace
        </Button>
      </div>
      <p className="text-sm text-slate-600">
        Attendance is accepted only within a workplace’s radius. The radius is never enlarged automatically for poor GPS accuracy. Typical values: 50–150 m for a building, larger for campuses.
      </p>
      {error && <Alert tone="danger">{error}</Alert>}
      {items && list.length === 0 && <EmptyState title="No workplaces yet">Add one so employees can clock in.</EmptyState>}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.map((w) => (
          <Card key={w.id} title={w.name} actions={w.active ? <Badge tone="success">Active</Badge> : <Badge>Inactive</Badge>}>
            <p className="text-sm text-slate-700">{w.address}</p>
            <p className="tabular text-sm text-slate-700">
              {w.lat.toFixed(6)}, {w.lng.toFixed(6)} · radius {w.radiusMeters} m
            </p>
            <p className="text-sm text-slate-700">Departments: {w.departmentIds.length ? w.departmentIds.map((d) => departments[d] ?? d).join(', ') : '—'}</p>
            <div className="mt-2 flex flex-wrap gap-2">
              <a className="text-sm font-semibold text-brand-700 underline" href={mapLinks(w.lat, w.lng).openStreetMap} target="_blank" rel="noreferrer">
                OpenStreetMap
              </a>
              <a className="text-sm font-semibold text-brand-700 underline" href={mapLinks(w.lat, w.lng).googleMaps} target="_blank" rel="noreferrer">
                Google Maps
              </a>
              <Button variant="ghost" onClick={() => setForm({ ...w, lat: String(w.lat), lng: String(w.lng), radiusMeters: String(w.radiusMeters), memberIds: w.memberIds ?? [] })}>
                Edit
              </Button>
            </div>
          </Card>
        ))}
      </div>
      {form && <WorkplaceForm form={form} setForm={setForm} onDone={() => { setForm(null); setToast('Workplace saved.'); }} />}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function WorkplaceForm({ form, setForm, onDone }: { form: Form; setForm: (f: Form | null) => void; onDone: () => void }) {
  const { departments } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locating, setLocating] = useState(false);
  const lat = Number(form.lat);
  const lng = Number(form.lng);
  const valid = form.lat !== '' && form.lng !== '' && Number.isFinite(lat) && Number.isFinite(lng) && Math.abs(lat) <= 90 && Math.abs(lng) <= 180;
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await callApi('workplace.upsert', { ...form, lat, lng, radiusMeters: Number(form.radiusMeters) });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function here() {
    setLocating(true);
    try {
      const r = await getFreshPosition();
      setForm({ ...form, lat: r.lat.toFixed(6), lng: r.lng.toFixed(6) });
      if (r.accuracy > 30) setError(`Captured with ±${Math.round(r.accuracy)} m accuracy. Verify on the map and adjust if needed.`);
    } catch {
      setError('Could not get your location. Enter coordinates manually.');
    } finally {
      setLocating(false);
    }
  }
  return (
    <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit workplace' : 'Add workplace'} wide>
      <div className="flex flex-col gap-3">
        {error && <Alert tone="warning">{error}</Alert>}
        <Field label="Location name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Address">{(id) => <Textarea id={id} className="min-h-16" value={form.address} onChange={(e) => setForm({ ...form, address: e.target.value })} />}</Field>
        <div className="grid grid-cols-3 gap-2">
          <Field label="Latitude">{(id) => <Input id={id} inputMode="decimal" value={form.lat} onChange={(e) => setForm({ ...form, lat: e.target.value })} />}</Field>
          <Field label="Longitude">{(id) => <Input id={id} inputMode="decimal" value={form.lng} onChange={(e) => setForm({ ...form, lng: e.target.value })} />}</Field>
          <Field label="Radius (m)">{(id) => <Input id={id} inputMode="numeric" value={form.radiusMeters} onChange={(e) => setForm({ ...form, radiusMeters: e.target.value })} />}</Field>
        </div>
        <p className="text-xs text-slate-600">Tip: in Google Maps, long-press the building to copy its coordinates. Radius 10–5000 m.</p>
        <Button variant="secondary" loading={locating} onClick={here}>
          Use my current location
        </Button>
        {valid && (
          <div>
            <iframe
              title="Map preview"
              className="h-56 w-full rounded-xl border border-slate-200"
              loading="lazy"
              referrerPolicy="no-referrer"
              src={mapLinks(lat, lng).osmEmbed(Number(form.radiusMeters) || 100)}
            />
            <p className="mt-1 text-xs text-slate-600">
              Map © OpenStreetMap contributors. The marker shows the center; verify it sits on the workplace.{' '}
              <a className="underline" href={mapLinks(lat, lng).googleMaps} target="_blank" rel="noreferrer">
                Open in Google Maps
              </a>
            </p>
          </div>
        )}
        <fieldset>
          <legend className="text-sm font-medium">Assigned departments</legend>
          <div className="grid grid-cols-1 sm:grid-cols-2">
            {Object.entries(departments).map(([d, n]) => (
              <label key={d} className="flex min-h-11 items-center gap-2">
                <input type="checkbox" className="h-5 w-5 accent-brand-600" checked={form.departmentIds.includes(d)} onChange={(e) => setForm({ ...form, departmentIds: e.target.checked ? [...form.departmentIds, d] : form.departmentIds.filter((x) => x !== d) })} />
                {n}
              </label>
            ))}
          </div>
          <p className="text-xs text-slate-600">Individual employees can also be authorized from their employee profile.</p>
        </fieldset>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
        </label>
        <Button loading={busy} disabled={!form.name || !valid} onClick={save}>
          Save workplace
        </Button>
      </div>
    </Modal>
  );
}
