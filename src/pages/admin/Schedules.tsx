import { useState } from 'react';
import { SCHEDULE_DEFAULTS, validateSchedule, isOvernight } from '../../../shared/schedule';
import type { ScheduleDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, EmptyState, Field, Input, Modal, Select, Toast } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { useCollection } from '../../lib/hooks';

const DAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
const blank = (): Omit<ScheduleDoc, 'id'> & { id?: string } => ({
  name: '',
  pattern: 'single',
  sessions: [{ start: '08:00', end: '17:00' }],
  workDays: [1, 2, 3, 4, 5],
  graceMinutes: SCHEDULE_DEFAULTS.graceMinutes,
  breakStart: '12:00',
  breakEnd: '13:00',
  flexible: false,
  flexMinutes: 0,
  earlyInMinutes: SCHEDULE_DEFAULTS.earlyInMinutes,
  cutoffMinutes: SCHEDULE_DEFAULTS.cutoffMinutes,
  overtimeThresholdMinutes: SCHEDULE_DEFAULTS.overtimeThresholdMinutes,
  active: true,
});

export default function Schedules() {
  const { orgId } = useSession();
  const { items, error } = useCollection<ScheduleDoc>(['organizations', orgId, 'schedules']);
  const [form, setForm] = useState<ReturnType<typeof blank> | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const list = [...(items ?? [])].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-navy-900">Schedules</h1>
        <Button variant="teal" onClick={() => setForm(blank())}>
          + Add schedule
        </Button>
      </div>
      <p className="text-sm text-slate-600">Editing a schedule affects shifts that have not started yet. Shifts already started keep a snapshot of the schedule they began with.</p>
      {error && <Alert tone="danger">{error}</Alert>}
      {items && list.length === 0 && <EmptyState title="No schedules yet" />}
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {list.map((s) => (
          <Card key={s.id} title={s.name} actions={<div className="flex gap-1">{isOvernight(s) && <Badge tone="info" icon="☾">Overnight</Badge>}{s.flexible && <Badge tone="info">Flexible</Badge>}{!s.active && <Badge>Inactive</Badge>}</div>}>
            <p className="tabular text-sm">
              {s.pattern === 'split' ? 'AM/PM: ' : ''}
              {s.sessions.map((x) => `${x.start}–${x.end}`).join(', ')}
            </p>
            <p className="text-sm text-slate-700">{s.workDays.map((d) => DAYS[d]).join(', ') || 'No work days'}</p>
            <p className="text-xs text-slate-600">
              Grace {s.graceMinutes}m · early in {s.earlyInMinutes}m · cutoff +{s.cutoffMinutes}m · OT after {s.overtimeThresholdMinutes}m
              {s.breakStart && ` · unpaid break ${s.breakStart}–${s.breakEnd}`}
              {s.flexible && ` · flex ${s.flexMinutes}m`}
            </p>
            <Button variant="ghost" className="mt-2" onClick={() => setForm({ ...blank(), ...s })}>
              Edit
            </Button>
          </Card>
        ))}
      </div>
      {form && <ScheduleForm form={form} setForm={setForm} onDone={() => { setForm(null); setToast('Schedule saved.'); }} />}
      <Toast message={toast} onDone={() => setToast(null)} />
    </div>
  );
}

function ScheduleForm({ form, setForm, onDone }: { form: ReturnType<typeof blank>; setForm: (f: ReturnType<typeof blank> | null) => void; onDone: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const local = validateSchedule(form);
  const num = (k: keyof ScheduleDoc, label: string, hint?: string) => (
    <Field label={label} hint={hint}>
      {(id) => <Input id={id} type="number" min={0} max={720} value={form[k] as number} onChange={(e) => setForm({ ...form, [k]: Number(e.target.value) })} />}
    </Field>
  );
  const setPattern = (p: 'single' | 'split') =>
    setForm({
      ...form,
      pattern: p,
      sessions: p === 'single' ? [{ start: '08:00', end: '17:00' }] : [{ start: '08:00', end: '12:00' }, { start: '13:00', end: '17:00' }],
      breakStart: p === 'single' ? '12:00' : null,
      breakEnd: p === 'single' ? '13:00' : null,
    });
  async function save() {
    setBusy(true);
    setError(null);
    try {
      await callApi('schedule.upsert', { ...form, breakStart: form.breakStart || null, breakEnd: form.breakEnd || null });
      onDone();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Modal open onClose={() => setForm(null)} title={form.id ? 'Edit schedule' : 'Add schedule'} wide>
      <div className="flex flex-col gap-3">
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Name">{(id) => <Input id={id} value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} />}</Field>
        <Field label="Daily pattern">
          {(id) => (
            <Select id={id} value={form.pattern} onChange={(e) => setPattern(e.target.value as 'single' | 'split')}>
              <option value="single">One clock-in and one clock-out</option>
              <option value="split">AM In, AM Out, PM In, PM Out</option>
            </Select>
          )}
        </Field>
        {form.sessions.map((s, i) => (
          <div key={i} className="grid grid-cols-2 gap-2">
            <Field label={form.pattern === 'split' ? `${i ? 'PM' : 'AM'} start` : 'Start'}>
              {(id) => <Input id={id} type="time" value={s.start} onChange={(e) => setForm({ ...form, sessions: form.sessions.map((x, j) => (j === i ? { ...x, start: e.target.value } : x)) })} />}
            </Field>
            <Field label={form.pattern === 'split' ? `${i ? 'PM' : 'AM'} end` : 'End'} hint={i === form.sessions.length - 1 ? 'An end earlier than the start means the next day (overnight).' : undefined}>
              {(id) => <Input id={id} type="time" value={s.end} onChange={(e) => setForm({ ...form, sessions: form.sessions.map((x, j) => (j === i ? { ...x, end: e.target.value } : x)) })} />}
            </Field>
          </div>
        ))}
        {form.pattern === 'single' && (
          <div className="grid grid-cols-2 gap-2">
            <Field label="Unpaid break start (optional)">{(id) => <Input id={id} type="time" value={form.breakStart ?? ''} onChange={(e) => setForm({ ...form, breakStart: e.target.value || null })} />}</Field>
            <Field label="Unpaid break end">{(id) => <Input id={id} type="time" value={form.breakEnd ?? ''} onChange={(e) => setForm({ ...form, breakEnd: e.target.value || null })} />}</Field>
          </div>
        )}
        <fieldset>
          <legend className="text-sm font-medium">Work days (others are rest days)</legend>
          <div className="flex flex-wrap gap-2">
            {DAYS.map((d, i) => (
              <label key={d} className="flex min-h-11 items-center gap-1 rounded-lg border border-slate-200 px-2">
                <input type="checkbox" className="h-5 w-5 accent-brand-600" checked={form.workDays.includes(i)} onChange={(e) => setForm({ ...form, workDays: e.target.checked ? [...form.workDays, i] : form.workDays.filter((x) => x !== i) })} />
                {d}
              </label>
            ))}
          </div>
        </fieldset>
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {num('graceMinutes', 'Grace (min)', 'Not late within this')}
          {num('earlyInMinutes', 'Early clock-in (min)', 'Before start')}
          {num('cutoffMinutes', 'Cutoff (min)', 'After end; absence after')}
          {num('overtimeThresholdMinutes', 'OT threshold (min)', 'Flag potential OT')}
        </div>
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={form.flexible} onChange={(e) => setForm({ ...form, flexible: e.target.checked })} /> Flexible start
        </label>
        {form.flexible && num('flexMinutes', 'Flex window (min)', 'Start may float this much; end moves with it')}
        <label className="flex min-h-11 items-center gap-2">
          <input type="checkbox" className="h-5 w-5" checked={form.active} onChange={(e) => setForm({ ...form, active: e.target.checked })} /> Active
        </label>
        {local && <Alert tone="warning">{local}</Alert>}
        <Button loading={busy} disabled={!!local} onClick={save}>
          Save schedule
        </Button>
      </div>
    </Modal>
  );
}
