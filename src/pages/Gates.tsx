import { useState } from 'react';
import { BrandHeader } from '../components/Brand';
import { Alert, Button, Card } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { callApi } from '../lib/api';

function Shell({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-dvh bg-slate-50 px-4 py-6">
      <div className="mx-auto flex max-w-xl flex-col gap-4">
        <BrandHeader />
        {children}
      </div>
    </div>
  );
}

export function ConfigMissing() {
  return (
    <div className="p-6">
      <Alert tone="danger" title="Firebase is not configured">
        Copy <code>.env.example</code> to <code>.env</code> (or <code>.env.development.example</code> to <code>.env.development.local</code> for emulators) and rebuild. See docs/SETUP.md.
      </Alert>
    </div>
  );
}

export function InactiveAccount() {
  const { logout } = useAuth();
  return (
    <Shell>
      <Alert tone="danger" title="Your account is inactive">
        You cannot record attendance or view organization data. If you think this is a mistake, contact your HR administrator.
      </Alert>
      <Button variant="secondary" onClick={logout}>
        Sign out
      </Button>
    </Shell>
  );
}

export function AccountProblem({ message }: { message: string }) {
  const { logout } = useAuth();
  return (
    <Shell>
      <Alert tone="warning" title="We could not open your account">
        {message}
      </Alert>
      <div className="flex gap-2">
        <Button onClick={() => location.reload()}>Retry</Button>
        <Button variant="secondary" onClick={logout}>
          Sign out
        </Button>
      </div>
    </Shell>
  );
}

/** First-login (and on every notice revision) location privacy notice. */
export function PrivacyGate() {
  const { org, logout } = useAuth();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!org) return null;
  async function accept() {
    setBusy(true);
    setError(null);
    try {
      await callApi('me.acceptPrivacy', { version: org!.settings.privacyNoticeVersion });
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <Shell>
      <Card title="Location privacy notice">
        <div className="max-h-[55vh] overflow-y-auto whitespace-pre-line rounded-xl bg-slate-50 p-3 text-sm leading-relaxed text-slate-800" tabIndex={0}>
          {org.settings.privacyNoticeText}
        </div>
        <p className="mt-3 text-xs text-slate-600">Notice version {org.settings.privacyNoticeVersion}</p>
        {error && <Alert tone="danger" className="mt-3">{error}</Alert>}
        <div className="mt-4 flex flex-col gap-2">
          <Button variant="teal" loading={busy} onClick={accept} className="w-full text-lg">
            I have read and understand
          </Button>
          <Button variant="ghost" onClick={logout}>
            Sign out
          </Button>
        </div>
      </Card>
    </Shell>
  );
}
