import { orderBy, where } from 'firebase/firestore';
import { useEffect, useState } from 'react';
import { isAttendanceAdmin, isSysAdmin } from '../../../shared/roles';
import type { DeviceDoc } from '../../../shared/types';
import { Alert, Badge, Button, Card, EmptyState, Field, Modal, Textarea } from '../../components/ui';
import { useSession } from '../../context/AuthContext';
import { callApi } from '../../lib/api';
import { fmtDateTime } from '../../lib/format';
import { useCollection, type MemberRow } from '../../lib/hooks';

const STATUS: Record<DeviceDoc['status'], ['success' | 'warning' | 'danger' | 'neutral', string]> = {
  active: ['success', 'Active'],
  pending: ['warning', 'Awaiting approval'],
  revoked: ['danger', 'Revoked'],
  replaced: ['neutral', 'Replaced'],
  superseded: ['neutral', 'Superseded'],
};

function DeviceRow({ d, tz, canAct, onApprove, onRevoke, showName }: { d: DeviceDoc; tz: string; canAct: boolean; onApprove: () => void; onRevoke: () => void; showName?: boolean }) {
  const [tone, label] = STATUS[d.status];
  return (
    <li className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 p-3 text-sm">
      <div className="min-w-0">
        <p className="font-semibold">
          {showName ? `${d.memberName} · ` : ''}
          {d.label}
        </p>
        <p className="text-xs text-slate-600">
          Registered {fmtDateTime(d.createdAt, tz)}
          {d.approvedByName ? ` · approved by ${d.approvedByName}` : ''}
          {d.lastUsedAt ? ` · last used ${fmtDateTime(d.lastUsedAt, tz)}` : ''}
        </p>
        {d.backedUp && <p className="text-xs text-amber-800">Passkey syncs to the employee’s own Google/Apple account devices.</p>}
        {d.revokedReason && <p className="text-xs text-slate-600">Reason: {d.revokedReason}</p>}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {canAct && d.status === 'pending' && (
          <Button variant="teal" onClick={onApprove}>
            ✓ Approve
          </Button>
        )}
        {canAct && (d.status === 'active' || d.status === 'pending') && (
          <Button variant="ghost" onClick={onRevoke}>
            Revoke
          </Button>
        )}
      </div>
    </li>
  );
}

function useDeviceActions(onToast: (m: string) => void) {
  const [revoking, setRevoking] = useState<DeviceDoc | null>(null);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function run(op: string, data: unknown, msg: string) {
    setBusy(true);
    setError(null);
    try {
      await callApi(op, data);
      onToast(msg);
      setRevoking(null);
      setReason('');
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  const dialog = (
    <Modal open={!!revoking} onClose={() => setRevoking(null)} title="Revoke phone">
      <div className="flex flex-col gap-3">
        <p className="text-sm">The employee will not be able to clock in with “{revoking?.label}” until a new phone is registered and approved.</p>
        {error && <Alert tone="danger">{error}</Alert>}
        <Field label="Reason (recorded in audit log)">{(id) => <Textarea id={id} value={reason} onChange={(e) => setReason(e.target.value)} />}</Field>
        <Button variant="danger" loading={busy} disabled={reason.trim().length < 3} onClick={() => revoking && run('device.revoke', { id: revoking.id, reason }, 'Phone revoked.')}>
          Revoke phone
        </Button>
      </div>
    </Modal>
  );
  return { approve: (d: DeviceDoc) => run('device.approve', { id: d.id }, 'Phone approved.'), revoke: setRevoking, dialog, error };
}

/** Registered phones for one employee (employee detail page). */
export function MemberDevicesCard({ m, onToast }: { m: MemberRow; onToast: (s: string) => void }) {
  const { orgId, member: me, org, tz } = useSession();
  const { items } = useCollection<DeviceDoc>(['organizations', orgId, 'devices'], [where('memberId', '==', m.uid)], m.uid);
  const actions = useDeviceActions(onToast);
  const canAct = isAttendanceAdmin(me.role) && me.uid !== m.uid && (isSysAdmin(me.role) || !isAttendanceAdmin(m.role));
  const mode = org.settings.deviceBinding.mode;
  const list = [...(items ?? [])].sort((a, b) => b.createdAt - a.createdAt);
  // Optimistic toggle: reflect the change immediately, revert if the server refuses.
  const [required, setRequired] = useState(!!m.deviceBindingRequired);
  useEffect(() => setRequired(!!m.deviceBindingRequired), [m.deviceBindingRequired]);
  return (
    <Card title="Registered phones">
      {mode === 'off' && <p className="mb-2 text-sm text-slate-600">Registered-phone verification is off (Settings).</p>}
      {mode === 'all' && <p className="mb-2 text-sm text-slate-600">Required for all employees.</p>}
      {mode === 'selected' && canAct && (
        <label className="mb-2 flex min-h-11 items-center gap-2 text-sm">
          <input
            type="checkbox"
            className="h-5 w-5 accent-brand-600"
            checked={required}
            onChange={async (e) => {
              const next = e.target.checked;
              setRequired(next);
              try {
                await callApi('employee.setDeviceBinding', { uid: m.uid, required: next });
                onToast(next ? 'Registered phone now required for this employee.' : 'Requirement removed.');
              } catch (err) {
                setRequired(!next);
                onToast((err as Error).message);
              }
            }}
          />
          Require a registered phone for this employee (pilot)
        </label>
      )}
      {actions.error && <Alert tone="danger" className="mb-2">{actions.error}</Alert>}
      {items && list.length === 0 && <p className="text-sm text-slate-600">No phone registered yet. The employee registers from Profile → Registered phone.</p>}
      <ul className="flex flex-col gap-2">
        {list.map((d) => (
          <DeviceRow key={d.id} d={d} tz={tz} canAct={canAct} onApprove={() => actions.approve(d)} onRevoke={() => actions.revoke(d)} />
        ))}
      </ul>
      {actions.dialog}
    </Card>
  );
}

/** HR queue of phone registrations awaiting approval (Approvals page). */
export function PendingDevicesCard({ onToast }: { onToast: (s: string) => void }) {
  const { orgId, member: me, tz } = useSession();
  const { items } = useCollection<DeviceDoc>(['organizations', orgId, 'devices'], [where('status', '==', 'pending'), orderBy('createdAt', 'desc')], 'pending');
  const actions = useDeviceActions(onToast);
  if (!items) return null;
  return (
    <Card title={`Phone registrations awaiting approval (${items.length})`}>
      {actions.error && <Alert tone="danger" className="mb-2">{actions.error}</Alert>}
      {items.length === 0 ? (
        <EmptyState title="No phones waiting for approval" />
      ) : (
        <ul className="flex flex-col gap-2">
          {items.map((d) => (
            <DeviceRow key={d.id} d={d} tz={tz} showName canAct={d.memberId !== me.uid} onApprove={() => actions.approve(d)} onRevoke={() => actions.revoke(d)} />
          ))}
        </ul>
      )}
      <p className="mt-2 text-xs text-slate-500">Before approving a replacement, confirm with the employee that the new phone is theirs (for example, in person). Approving retires their previous phone.</p>
      {actions.dialog}
    </Card>
  );
}
