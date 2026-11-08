import type { OrgSettings } from './types';

export const DEFAULT_PRIVACY_NOTICE = `Candoni Attendance collects your device location ONLY at the moment you tap an attendance action (for example, Clock In or Clock Out). It is used to check that you are within an authorized workplace area, an approved fieldwork location, or your approved work-from-home location.

What is collected: latitude, longitude, the accuracy reported by your device, and the time the reading was captured, together with the official server time of your attendance action.

What is NOT collected: there is no continuous or background tracking, no photos, no biometrics, and no device fingerprinting.

Who can see it: precise coordinates are visible only to you and to authorized HR/attendance administrators. Supervisors and standard reports see the workplace name and distance, not exact coordinates.

Retention: location evidence is kept according to the organization's retention policy.

Important: browser location is reported by your device and is used as supporting evidence only. Your organization may review records and request explanations.

If you deny location permission, you can still view your records, but you will not be able to clock in or out. You may submit a correction, fieldwork or work-from-home request instead.`;

export const DEFAULT_SETTINGS: OrgSettings = {
  timezone: 'Asia/Manila',
  maxAccuracyMeters: 100,
  maxLocationAgeSeconds: 60,
  minActionIntervalSeconds: 60,
  allowUnscheduledAttendance: true,
  unscheduledMaxHours: 16,
  wfhEnabled: true,
  approvalMode: 'supervisor_or_hr',
  privacyNoticeVersion: 1,
  privacyNoticeText: DEFAULT_PRIVACY_NOTICE,
  retention: { enabled: false, rejectedAttemptDays: 365, locationEvidenceDays: 1095 },
};

export const LIMITS = {
  minRadiusMeters: 10,
  maxRadiusMeters: 5000,
  minAccuracyMeters: 5,
  maxAccuracyMeters: 1000,
  maxLocationAgeSeconds: 600,
  /** Allowed clock skew when the device timestamp is ahead of server time. */
  futureSkewSeconds: 120,
};
