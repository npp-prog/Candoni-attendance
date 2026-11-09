import { browserLocalPersistence, browserSessionPersistence, sendPasswordResetEmail, setPersistence, signInWithEmailAndPassword } from 'firebase/auth';
import { FirebaseError } from 'firebase/app';
import { useState, type FormEvent } from 'react';
import { BrandMark } from '../components/Brand';
import { Alert, Button, Field, Input } from '../components/ui';
import { useAuth } from '../context/AuthContext';
import { auth } from '../firebase';

function authMessage(e: unknown) {
  const code = e instanceof FirebaseError ? e.code : '';
  if (['auth/invalid-credential', 'auth/wrong-password', 'auth/user-not-found', 'auth/invalid-email'].includes(code)) return 'Incorrect email or password.';
  if (code === 'auth/user-disabled') return 'This account is deactivated. Contact HR.';
  if (code === 'auth/too-many-requests') return 'Too many attempts. Wait a few minutes or reset your password.';
  if (code === 'auth/network-request-failed') return 'No connection. Check your internet and try again.';
  return 'Sign-in failed. Please try again.';
}

export default function Login() {
  const { branding } = useAuth();
  const [mode, setMode] = useState<'login' | 'reset'>('login');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [remember, setRemember] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);

  async function onLogin(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // On shared devices, "keep me signed in" off limits the session to this browser tab.
      await setPersistence(auth, remember ? browserLocalPersistence : browserSessionPersistence);
      await signInWithEmailAndPassword(auth, email.trim(), password);
    } catch (err) {
      setError(authMessage(err));
    } finally {
      setBusy(false);
    }
  }

  async function onReset(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await sendPasswordResetEmail(auth, email.trim());
    } catch (err) {
      if (err instanceof FirebaseError && err.code === 'auth/network-request-failed') {
        setError(authMessage(err));
        setBusy(false);
        return;
      }
    }
    // Same message either way, so the form does not reveal which emails exist.
    setInfo('If an account exists for that email, a password reset link has been sent. Check your inbox and spam folder.');
    setBusy(false);
  }

  return (
    <div className="flex min-h-dvh flex-col bg-gradient-to-b from-navy-900 to-navy-800 px-4 py-10">
      <div className="mx-auto w-full max-w-sm">
        <div className="mb-6 flex flex-col items-center gap-3 text-center text-white">
          <BrandMark size={64} />
          <h1 className="text-2xl font-bold">{branding.name}</h1>
          <p className="text-sm text-navy-100">Employee attendance</p>
        </div>
        <div className="rounded-2xl bg-white p-5 shadow-xl">
          {mode === 'login' ? (
            <form onSubmit={onLogin} className="flex flex-col gap-4" noValidate>
              <h2 className="text-lg font-semibold text-navy-900">Sign in</h2>
              {error && <Alert tone="danger">{error}</Alert>}
              <Field label="Work email">{(id) => <Input id={id} type="email" autoComplete="username" inputMode="email" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
              <Field label="Password">{(id) => <Input id={id} type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />}</Field>
              <label className="flex min-h-11 items-center gap-3 text-sm text-slate-700">
                <input type="checkbox" className="h-5 w-5 accent-brand-600" checked={remember} onChange={(e) => setRemember(e.target.checked)} />
                Keep me signed in on this device
              </label>
              <Button type="submit" loading={busy} disabled={!email || !password} className="w-full text-lg">
                Sign in
              </Button>
              <button type="button" className="min-h-11 text-sm font-semibold text-brand-700 underline" onClick={() => { setMode('reset'); setError(null); }}>
                Forgot password?
              </button>
            </form>
          ) : (
            <form onSubmit={onReset} className="flex flex-col gap-4">
              <h2 className="text-lg font-semibold text-navy-900">Reset password</h2>
              <p className="text-sm text-slate-600">Enter your work email and we will send a link to set a new password.</p>
              {error && <Alert tone="danger">{error}</Alert>}
              {info && <Alert tone="success">{info}</Alert>}
              <Field label="Work email">{(id) => <Input id={id} type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />}</Field>
              <Button type="submit" loading={busy} disabled={!email} className="w-full">
                Send reset link
              </Button>
              <button type="button" className="min-h-11 text-sm font-semibold text-brand-700 underline" onClick={() => { setMode('login'); setInfo(null); }}>
                Back to sign in
              </button>
            </form>
          )}
        </div>
        <p className="mt-6 text-center text-xs text-navy-100">Accounts are created by your HR administrator. There is no public sign-up.</p>
      </div>
    </div>
  );
}
