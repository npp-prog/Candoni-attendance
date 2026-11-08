/**
 * Shared domain types for Candoni Attendance.
 *
 * These types describe Firestore documents (all scoped under
 * organizations/{orgId}/...) and the payloads exchanged with Cloud Functions.
 * Timestamps are stored in UTC (Firestore Timestamp on the server, ISO strings
 * or epoch milliseconds in callable payloads). Work dates are local calendar
 * dates in the organization timezone, formatted YYYY-MM-DD.
 */

export type Role = 'employee' | 'supervisor' | 'hr' | 'sysadmin';
export const ROLES: Role[] = ['employee', 'supervisor', 'hr', 'sysadmin'];

export type SinglePatternAction = 'IN' | 'OUT';
export type SplitPatternAction = 'AM_IN' | 'AM_OUT' | 'PM_IN' | 'PM_OUT';
export type AttendanceAction = SinglePatternAction | SplitPatternAction;
export const ALL_ACTIONS: AttendanceAction[] = ['IN', 'OUT', 'AM_IN', 'AM_OUT', 'PM_IN', 'PM_OUT'];

export const ACTION_LABELS: Record<AttendanceAction, string> = {
  IN: 'Clock In',
  OUT: 'Clock Out',
  AM_IN: 'AM In',
  AM_OUT: 'AM Out',
  PM_IN: 'PM In',
  PM_OUT: 'PM Out',
};

export type SchedulePattern = 'single' | 'split';

/** A working session expressed as local "HH:mm" times relative to the work date. */
export interface SessionTemplate {
  start: string;
  end: string;
}

export interface ScheduleDoc {
  id: string;
  name: string;
  pattern: SchedulePattern;
  /** 1 session for "single", 2 sessions (AM, PM) for "split". */
  sessions: SessionTemplate[];
  /** Working weekdays, 0 = Sunday ... 6 = Saturday. Other days are rest days. */
  workDays: number[];
  /** Minutes after scheduled start before an arrival is counted late. */
  graceMinutes: number;
  /** Optional unpaid break inside a single-pattern shift (local HH:mm). */
  breakStart?: string | null;
  breakEnd?: string | null;
  /** Flexible schedule: start may float up to flexMinutes after scheduled start. */
  flexible: boolean;
  flexMinutes: number;
  /** How early before the first session an employee may clock in. */
  earlyInMinutes: number;
  /** Minutes after the last scheduled end when the shift window closes (cutoff). */
  cutoffMinutes: number;
  /** Minimum minutes after scheduled end before extra time is flagged as potential overtime. */
  overtimeThresholdMinutes: number;
  active: boolean;
}

export interface ScheduleAssignmentDoc {
  id: string;
  memberId: string;
  scheduleId: string;
  effectiveFrom: string; // YYYY-MM-DD inclusive
  effectiveTo: string | null; // YYYY-MM-DD inclusive, null = open-ended
}

export interface HolidayDoc {
  id: string;
  date: string;
  name: string;
  type: 'regular' | 'special' | 'company';
}

export interface LeaveDoc {
  id: string;
  memberId: string;
  departmentId: string;
  from: string;
  to: string;
  type: string;
  note?: string;
}

export interface WorkplaceDoc {
  id: string;
  name: string;
  address: string;
  lat: number;
  lng: number;
  radiusMeters: number;
  active: boolean;
  /** Departments whose members may use this workplace. */
  departmentIds: string[];
  /** Individually assigned members (in addition to departments). */
  memberIds: string[];
}

export interface MemberDoc {
  uid: string;
  orgId: string;
  employeeNumber: string;
  fullName: string;
  email: string;
  departmentId: string;
  position: string;
  classification: string;
  supervisorUid: string | null;
  role: Role;
  /** Departments a supervisor/department head may oversee. */
  supervisedDepartmentIds: string[];
  /** Individually authorized workplaces (in addition to department workplaces). */
  workplaceIds: string[];
  active: boolean;
  privacyAcceptedVersion: number | null;
}

export interface OrgSettings {
  timezone: string;
  /** Reject readings whose reported accuracy (meters) is worse than this. */
  maxAccuracyMeters: number;
  /** Reject readings captured more than this many seconds before submission. */
  maxLocationAgeSeconds: number;
  /** Minimum seconds between two consecutive attendance actions. */
  minActionIntervalSeconds: number;
  /** Allow clocking in on rest days/holidays/without a schedule (flagged as unscheduled). */
  allowUnscheduledAttendance: boolean;
  /** Maximum length of an unscheduled shift before clock-out is no longer accepted. */
  unscheduledMaxHours: number;
  /** Whether employees may request work-from-home authorizations. */
  wfhEnabled: boolean;
  /** Who may approve correction/fieldwork/overtime requests. */
  approvalMode: 'supervisor_or_hr' | 'hr_only';
  privacyNoticeVersion: number;
  privacyNoticeText: string;
  retention: {
    /** Destructive deletion stays disabled unless explicitly enabled. */
    enabled: boolean;
    rejectedAttemptDays: number;
    locationEvidenceDays: number;
  };
}

export interface OrganizationDoc {
  id: string;
  name: string;
  shortName: string;
  logoUrl: string | null;
  settings: OrgSettings;
}

export interface LocationReading {
  lat: number;
  lng: number;
  accuracy: number;
  /** Epoch ms when the browser captured the position. */
  capturedAt: number;
}

/** Concrete session instance for a specific work date (UTC epoch ms). */
export interface SessionInstance {
  start: number;
  end: number;
}

export type DayKind = 'workday' | 'rest_day' | 'holiday' | 'no_schedule';

/** A resolved shift for a member and work date. Pure data, safe to snapshot. */
export interface ShiftPlan {
  workDate: string;
  kind: DayKind;
  scheduleId: string | null;
  scheduleName: string | null;
  pattern: SchedulePattern;
  sessions: SessionInstance[];
  graceMinutes: number;
  flexible: boolean;
  flexMinutes: number;
  breakWindow: SessionInstance | null;
  /** When attendance actions for this shift become available. */
  windowOpen: number;
  /** Shift cutoff: last moment actions are accepted; absence decided after this. */
  windowClose: number;
  overtimeThresholdMinutes: number;
  holidayName: string | null;
  unscheduled: boolean;
}

export type DayStatus =
  | 'rest_day'
  | 'holiday'
  | 'leave'
  | 'no_schedule'
  | 'upcoming'
  | 'awaiting'
  | 'in_progress'
  | 'completed'
  | 'incomplete'
  | 'absent'
  | 'fieldwork'
  | 'wfh';

export const STATUS_LABELS: Record<DayStatus, string> = {
  rest_day: 'Rest day',
  holiday: 'Holiday',
  leave: 'On leave',
  no_schedule: 'No schedule',
  upcoming: 'Upcoming',
  awaiting: 'Awaiting clock-in',
  in_progress: 'In progress',
  completed: 'Completed',
  incomplete: 'Incomplete',
  absent: 'Absent',
  fieldwork: 'Fieldwork',
  wfh: 'Work from home',
};

export type ExceptionCode =
  | 'LATE'
  | 'UNDERTIME'
  | 'MISSING_ACTION'
  | 'ABSENT'
  | 'UNSCHEDULED_WORK'
  | 'OVERTIME_CANDIDATE'
  | 'CORRECTED'
  | 'FIELDWORK_NO_PUNCH'
  | 'WFH_NO_PUNCH';

export interface DayComputation {
  workDate: string;
  status: DayStatus;
  kind: DayKind;
  punches: Partial<Record<AttendanceAction, number>>;
  correctedActions: AttendanceAction[];
  lateMinutes: number;
  undertimeMinutes: number;
  workedMinutes: number;
  overtimeCandidateMinutes: number;
  missingActions: AttendanceAction[];
  exceptions: ExceptionCode[];
}

export type RequestType = 'missing_punch' | 'incorrect_punch' | 'fieldwork' | 'wfh' | 'explanation' | 'overtime';
export const REQUEST_TYPE_LABELS: Record<RequestType, string> = {
  missing_punch: 'Missing clock-in/out',
  incorrect_punch: 'Incorrect attendance',
  fieldwork: 'Official business / fieldwork',
  wfh: 'Work from home',
  explanation: 'Exception explanation',
  overtime: 'Overtime approval',
};

export type RequestStatus = 'pending' | 'approved' | 'rejected' | 'cancelled';

/** Remote-work authorizations share one structure; `category` tells them apart. */
export type RemoteCategory = 'fieldwork' | 'wfh';

export interface FieldworkDetails {
  /** Missing on records created before WFH existed; treat as 'fieldwork'. */
  category?: RemoteCategory;
  /** Epoch ms window (UTC) during which the authorization applies. */
  startAt: number;
  endAt: number;
  mode: 'alternate_location' | 'exemption';
  locationName?: string;
  lat?: number;
  lng?: number;
  radiusMeters?: number;
  purpose: string;
}
