/**
 * Structured rejection codes returned by the attendance backend. The frontend
 * shows the friendly message and, where useful, the practical guidance.
 */
export type RejectionCode =
  | 'UNAUTHENTICATED'
  | 'NOT_A_MEMBER'
  | 'ACCOUNT_INACTIVE'
  | 'PRIVACY_NOTICE_REQUIRED'
  | 'INVALID_REQUEST'
  | 'RATE_LIMITED'
  | 'LOCATION_MISSING'
  | 'LOCATION_INVALID'
  | 'LOCATION_INACCURATE'
  | 'LOCATION_STALE'
  | 'LOCATION_FROM_FUTURE'
  | 'NO_AUTHORIZED_WORKPLACE'
  | 'OUTSIDE_GEOFENCE'
  | 'ACTION_NOT_ALLOWED'
  | 'TOO_EARLY'
  | 'SHIFT_CLOSED'
  | 'SHIFT_COMPLETE'
  | 'NOT_SCHEDULED'
  | 'TOO_SOON'
  | 'DEVICE_NOT_REGISTERED'
  | 'DEVICE_PENDING_APPROVAL'
  | 'DEVICE_VERIFICATION_REQUIRED'
  | 'DEVICE_VERIFICATION_FAILED'
  | 'REQUEST_ID_REUSED'
  | 'CONFLICT';

export const REJECTION_MESSAGES: Record<RejectionCode, string> = {
  UNAUTHENTICATED: 'Please sign in again.',
  NOT_A_MEMBER: 'Your account is not linked to an employee profile. Contact HR.',
  ACCOUNT_INACTIVE: 'Your account is inactive. Attendance cannot be recorded. Contact HR.',
  PRIVACY_NOTICE_REQUIRED: 'Please review and accept the location privacy notice first.',
  INVALID_REQUEST: 'The request was incomplete or invalid. Please try again.',
  RATE_LIMITED: 'Too many attempts in a short time. Please wait a minute and try again.',
  LOCATION_MISSING: 'A current location reading is required to record attendance.',
  LOCATION_INVALID: 'The location reading was not valid. Please retry.',
  LOCATION_INACCURATE: 'Your location reading is not precise enough. Move near a window or outdoors, wait a few seconds, and retry.',
  LOCATION_STALE: 'Your location reading is too old. Please retry to capture a fresh position.',
  LOCATION_FROM_FUTURE: 'Your device clock appears to be incorrect. Enable automatic date & time and retry.',
  NO_AUTHORIZED_WORKPLACE: 'You have no authorized workplace assigned. Contact HR or request fieldwork or work-from-home authorization.',
  OUTSIDE_GEOFENCE: 'You are outside your authorized workplace area.',
  ACTION_NOT_ALLOWED: 'That attendance action is not the next valid action.',
  TOO_EARLY: 'Attendance for your shift is not open yet.',
  SHIFT_CLOSED: 'The attendance window for this shift has closed. Submit a correction request.',
  SHIFT_COMPLETE: 'All attendance actions for this shift are already recorded.',
  NOT_SCHEDULED: 'Attendance is not expected today.',
  TOO_SOON: 'Your previous action was just recorded. Please wait a moment.',
  DEVICE_NOT_REGISTERED: 'Your organization requires a registered phone. Register this phone first (Profile → Registered phone).',
  DEVICE_PENDING_APPROVAL: 'Your phone registration is waiting for HR approval.',
  DEVICE_VERIFICATION_REQUIRED: 'Confirm with your phone’s fingerprint, face or PIN to clock in.',
  DEVICE_VERIFICATION_FAILED: 'This phone could not be verified as your registered phone. Use your own registered phone, or ask HR to approve a new one.',
  REQUEST_ID_REUSED: 'This request ID was already used for a different action. Refresh and try again.',
  CONFLICT: 'Another attendance submission was processed at the same time. Refresh and check your status.',
};

export interface AttendanceRejection {
  ok: false;
  code: RejectionCode;
  message: string;
  details?: Record<string, unknown>;
}
