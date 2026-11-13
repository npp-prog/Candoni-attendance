import { FirebaseError } from 'firebase/app';
import { httpsCallable } from 'firebase/functions';
import { functions } from '../firebase';
import type { RejectionCode } from '../../shared/errors';
import type { AttendanceAction, ShiftPlan } from '../../shared/types';
import type { Punches } from '../../shared/attendance';

export class ApiError extends Error {
  constructor(
    message: string,
    public code: string,
    /** True when the request may not have reached the server (network/timeout). */
    public uncertain: boolean,
  ) {
    super(message);
  }
}

const NETWORK_CODES = new Set(['functions/unavailable', 'functions/deadline-exceeded', 'functions/internal', 'functions/unknown']);

function toApiError(e: unknown): ApiError {
  if (e instanceof FirebaseError) {
    const uncertain = NETWORK_CODES.has(e.code) || !navigator.onLine;
    const msg = uncertain
      ? 'Could not reach the server. Check your connection.'
      : e.message.replace(/^Firebase:\s*/, '');
    return new ApiError(msg, e.code, uncertain);
  }
  return new ApiError((e as Error)?.message ?? 'Unexpected error', 'unknown', true);
}

export async function callApi<T = unknown>(op: string, data?: unknown): Promise<T> {
  try {
    const fn = httpsCallable(functions, 'api', { timeout: 60_000 });
    // The callable protocol encodes `undefined` as null; drop absent fields instead.
    const clean = data === undefined ? undefined : JSON.parse(JSON.stringify(data));
    const res = await fn({ op, data: clean });
    return res.data as T;
  } catch (e) {
    throw toApiError(e);
  }
}

export interface ClockReceipt {
  ok: true;
  replayed: boolean;
  eventId: string;
  action: AttendanceAction;
  workDate: string;
  at: number;
  timezone: string;
  workplaceName: string;
  workplaceId: string;
  distanceMeters: number | null;
  accuracyMeters: number;
  validation: 'geofence' | 'fieldwork_location' | 'fieldwork_exemption' | 'wfh_location' | 'wfh_exemption';
  deviceVerified?: boolean;
}
export interface ClockRejection {
  ok: false;
  code: RejectionCode;
  message: string;
  details?: Record<string, unknown>;
}

export async function clockAttendance(payload: {
  requestId: string;
  action: AttendanceAction;
  location: { lat: number; lng: number; accuracy: number; capturedAt: number; sentAt: number };
  deviceHint?: string;
  deviceAssertion?: unknown;
}): Promise<ClockReceipt | ClockRejection> {
  try {
    const fn = httpsCallable(functions, 'clockAttendance', { timeout: 25_000 });
    return (await fn(payload)).data as ClockReceipt | ClockRejection;
  } catch (e) {
    throw toApiError(e);
  }
}

export async function attendanceStatus(requestId: string): Promise<{ found: boolean; receipt?: ClockReceipt }> {
  try {
    const fn = httpsCallable(functions, 'attendanceStatus', { timeout: 20_000 });
    return (await fn({ requestId })).data as { found: boolean; receipt?: ClockReceipt };
  } catch (e) {
    throw toApiError(e);
  }
}

export interface TodayData {
  serverTime: number;
  timezone: string;
  today: string;
  scheduleName: string | null;
  next: { code: string; action: AttendanceAction | null; altActions?: AttendanceAction[]; workDate: string; message: string; availableAt: number | null };
  plan: ShiftPlan;
  punches: Punches;
  correctedActions: AttendanceAction[];
  workplaces: { id: string; name: string; address: string; lat: number; lng: number; radiusMeters: number }[];
  fieldwork: {
    id: string;
    category: 'fieldwork' | 'wfh';
    mode: 'alternate_location' | 'exemption';
    purpose: string;
    startAt: number;
    endAt: number;
    locationName: string | null;
    lat: number | null;
    lng: number | null;
    radiusMeters: number | null;
  }[];
  limits: { maxAccuracyMeters: number; maxLocationAgeSeconds: number };
  wfhEnabled: boolean;
  device: { required: boolean; mode: 'off' | 'selected' | 'all'; status: 'none' | 'pending' | 'active'; activeLabel: string | null; pendingLabel: string | null };
}
