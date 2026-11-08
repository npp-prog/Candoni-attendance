import { useEffect, useState } from 'react';
import type { PublicKeyCredentialCreationOptionsJSON } from '@simplewebauthn/browser';
import { isFresh, passkeyErrorMessage, passkeySupport, prepareRegistration, registerThisPhone, type Prepared } from '../lib/device';
import { Alert, Badge, Button, Card } from './ui';

export interface DeviceInfo {
  required: boolean;
  mode: 'off' | 'selected' | 'all';
  status: 'none' | 'pending' | 'active';
  activeLabel: string | null;
  pendingLabel: string | null;
}

/**
 * Registers this phone as the employee's attendance phone with a passkey.
 * Two taps: "Register" prepares a server challenge, then "Confirm" starts the
 * phone's fingerprint/face/PIN prompt directly from the tap (required on iOS).
 */
export function PhoneRegistrationCard({ device, onChanged, compact }: { device: DeviceInfo; onChanged: () => void; compact?: boolean }) {
  const [support, setSupport] = useState<'ok' | 'unsupported' | 'no-screen-lock' | null>(null);
  const [prepared, setPrepared] = useState<Prepared<PublicKeyCredentialCreationOptionsJSON> | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<string | null>(null);

  useEffect(() => {
    passkeySupport().then(setSupport);
  }, []);

  async function prepare() {
    setBusy(true);
    setError(null);
    try {
      setPrepared(await prepareRegistration());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  async function confirm() {
    if (!prepared || !isFresh(prepared)) {
      setPrepared(null);
      return setError('That took too long. Tap “Register this phone” again.');
    }
    setBusy(true);
    setError(null);
    try {
      const r = await registerThisPhone(prepared);
      setDone(r.status === 'active' ? 'This phone is now your registered attendance phone.' : 'Registration sent. HR must approve this phone before you can use it to clock in.');
      setPrepared(null);
      onChanged();
    } catch (e) {
      setError(passkeyErrorMessage(e));
      setPrepared(null);
    } finally {
      setBusy(false);
    }
  }

  const statusBadge =
    device.status === 'active' ? <Badge tone="success">Registered</Badge> : device.status === 'pending' ? <Badge tone="warning" icon="…">Awaiting HR approval</Badge> : <Badge tone={device.required ? 'danger' : 'neutral'}>Not registered</Badge>;

  return (
    <Card title="Registered phone" actions={statusBadge}>
      <div className="flex flex-col gap-3 text-sm text-slate-700">
        {!compact && (
          <p>
            {device.required
              ? 'Your organization requires you to clock in from your own registered phone, confirmed with its fingerprint, face or PIN.'
              : 'Registering your phone is optional for you right now; your organization may require it later.'}{' '}
            The check happens on your phone; ClockUp never receives your fingerprint, face or PIN.
          </p>
        )}
        {device.status === 'active' && <p>Registered: <strong>{device.activeLabel}</strong></p>}
        {device.status === 'pending' && <p>Waiting for approval: <strong>{device.pendingLabel}</strong></p>}
        {done && <Alert tone="success">{done}</Alert>}
        {error && <Alert tone="danger">{error}</Alert>}
        {support === 'unsupported' && <Alert tone="warning">This browser cannot register a phone. Use an up-to-date Chrome (Android) or Safari (iPhone).</Alert>}
        {support === 'no-screen-lock' && <Alert tone="warning">Set up a screen lock (fingerprint, face or PIN) on this phone first, then reload this page.</Alert>}
        {support === 'ok' && !prepared && (
          <Button variant={device.status === 'active' ? 'secondary' : 'teal'} loading={busy} onClick={prepare}>
            {device.status === 'active' ? 'Replace with this phone (needs HR approval)' : device.status === 'pending' ? 'Register this phone instead' : 'Register this phone'}
          </Button>
        )}
        {prepared && (
          <>
            <p>Your phone will now ask for its fingerprint, face or PIN.</p>
            <Button variant="teal" className="min-h-14 text-lg" loading={busy} onClick={confirm}>
              Confirm with fingerprint, face or PIN
            </Button>
            <Button variant="ghost" onClick={() => setPrepared(null)}>
              Cancel
            </Button>
          </>
        )}
        <p className="text-xs text-slate-500">One phone per employee. A phone registered to someone else cannot be registered to you. Replacing a phone needs HR approval.</p>
      </div>
    </Card>
  );
}
