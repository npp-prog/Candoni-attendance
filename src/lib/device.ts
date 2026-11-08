import {
  browserSupportsWebAuthn,
  platformAuthenticatorIsAvailable,
  startAuthentication,
  startRegistration,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
} from '@simplewebauthn/browser';
import { callApi } from './api';

/**
 * Registered-phone verification (WebAuthn passkeys). The phone's own screen
 * lock (fingerprint, face or PIN) unlocks a private key that never leaves the
 * phone; ClockUp receives only a signature, never biometric data.
 */

const HINT_KEY = 'clockup.deviceHint';

/**
 * A random identifier stored in this browser. It is NOT proof of identity; it
 * only lets HR see when one phone is used for several accounts. Clearing site
 * data resets it.
 */
export function getDeviceHint(): string | undefined {
  try {
    let v = localStorage.getItem(HINT_KEY);
    if (!v) {
      v = crypto.randomUUID ? crypto.randomUUID() : Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
      localStorage.setItem(HINT_KEY, v);
    }
    return v;
  } catch {
    return undefined;
  }
}

export function deviceLabel(): string {
  const ua = navigator.userAgent;
  const os = /iPhone/.test(ua) ? 'iPhone' : /iPad/.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1) ? 'iPad' : /Android/.test(ua) ? 'Android phone' : /Windows/.test(ua) ? 'Windows PC' : /Mac/.test(ua) ? 'Mac' : 'Device';
  const browser = /EdgA?\//.test(ua) ? 'Edge' : /SamsungBrowser/.test(ua) ? 'Samsung Internet' : /CriOS|Chrome\//.test(ua) ? 'Chrome' : /FxiOS|Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${os} · ${browser}`;
}

export async function passkeySupport(): Promise<'ok' | 'unsupported' | 'no-screen-lock'> {
  if (!browserSupportsWebAuthn()) return 'unsupported';
  try {
    return (await platformAuthenticatorIsAvailable()) ? 'ok' : 'no-screen-lock';
  } catch {
    return 'no-screen-lock';
  }
}

/** Options fetched ahead of the tap (iOS needs the prompt to start from the tap itself). */
export interface Prepared<T> {
  options: T;
  fetchedAt: number;
}
const FRESH_MS = 90_000;
export const isFresh = (p: Prepared<unknown> | null) => !!p && Date.now() - p.fetchedAt < FRESH_MS;

export async function prepareRegistration(): Promise<Prepared<PublicKeyCredentialCreationOptionsJSON>> {
  return { options: await callApi<PublicKeyCredentialCreationOptionsJSON>('device.registerOptions'), fetchedAt: Date.now() };
}
export async function prepareVerification(): Promise<Prepared<PublicKeyCredentialRequestOptionsJSON>> {
  return { options: await callApi<PublicKeyCredentialRequestOptionsJSON>('device.authOptions'), fetchedAt: Date.now() };
}

export async function registerThisPhone(prepared: Prepared<PublicKeyCredentialCreationOptionsJSON>) {
  const response = await startRegistration({ optionsJSON: prepared.options });
  return callApi<{ id: string; status: 'active' | 'pending' }>('device.register', { response, deviceHint: getDeviceHint(), label: deviceLabel() });
}

export async function verifyThisPhone(prepared: Prepared<PublicKeyCredentialRequestOptionsJSON>) {
  return startAuthentication({ optionsJSON: prepared.options });
}

export function passkeyErrorMessage(e: unknown): string {
  const name = (e as { name?: string })?.name;
  if (name === 'NotAllowedError') return 'Phone verification did not complete. Only the phone registered to this account can be used to clock in. If this is your registered phone, tap the button again and confirm with your fingerprint, face or PIN.';
  if (name === 'InvalidStateError') return 'This phone is already registered for your account.';
  if (name === 'SecurityError') return 'Phone verification is not available on this app address. Contact your administrator.';
  return (e as Error)?.message || 'Phone verification failed.';
}
