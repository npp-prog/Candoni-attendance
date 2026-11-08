import type { AttendanceAction } from '../../shared/types';

/**
 * A submitted-but-unconfirmed attendance request is remembered on this device
 * so the employee can safely check or retry it with the same idempotency key.
 * It is never auto-submitted later and never treated as accepted.
 */
export interface PendingRequest {
  requestId: string;
  action: AttendanceAction;
  startedAt: number;
}
const key = (uid: string) => `candoni.pending.${uid}`;

export function newRequestId(): string {
  if (crypto.randomUUID) return crypto.randomUUID();
  const b = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}
export function loadPending(uid: string): PendingRequest | null {
  try {
    const raw = localStorage.getItem(key(uid));
    if (!raw) return null;
    const p = JSON.parse(raw) as PendingRequest;
    // Stale pending entries (older than a day) are dropped.
    if (Date.now() - p.startedAt > 86_400_000) {
      localStorage.removeItem(key(uid));
      return null;
    }
    return p;
  } catch {
    return null;
  }
}
export function savePending(uid: string, p: PendingRequest) {
  try {
    localStorage.setItem(key(uid), JSON.stringify(p));
  } catch {
    /* storage unavailable (private mode); retries still use the in-memory id */
  }
}
export function clearPending(uid: string) {
  try {
    localStorage.removeItem(key(uid));
  } catch {
    /* ignore */
  }
}
