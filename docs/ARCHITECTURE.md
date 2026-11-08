# Architecture, data model and policy decisions

## Overview

```
Phone browser (PWA)                         Firebase (asia-southeast1)
┌──────────────────────────┐   callable   ┌──────────────────────────────────────┐
│ React app (Netlify)      │ ───────────▶ │ clockAttendance   (trusted clock-in) │
│  - one-shot geolocation  │              │ attendanceStatus  (idempotency check)│
│  - reads via Firestore   │              │ api               (all other writes, │
│    rules (read-only)     │ ◀─────────── │                   reviews, reports)  │
└──────────────────────────┘   receipts   │ retentionJob      (disabled default) │
          │ reads                         └──────────────┬───────────────────────┘
          ▼                                              │ Admin SDK (transactions)
   Cloud Firestore  ◀────────────────────────────────────┘
```

- **Clients never write to Firestore.** Every create/update/delete goes through Cloud Functions, which authenticate the caller, re-read their member profile (active status and role are always fresh), validate input with zod, check role and department scope, and write an audit log in the same transaction/batch.
- **Clients read** through least-privilege security rules (own records; supervisors by department; HR/sysadmin organization-wide; precise coordinates only for the owner and HR/sysadmin).
- **`shared/`** contains the deterministic domain engine used by both the backend (authoritative) and the UI (previews and labels), so the same Haversine and schedule logic runs everywhere.

## Data model

Everything is organization-scoped from the start: `organizations/{orgId}/...`. The UI serves a single organization (`VITE_ORG_ID`).

| Path | Purpose | Written by |
| --- | --- | --- |
| `users/{uid}` | Maps an Auth user to `orgId` | Functions / bootstrap |
| `branding/{orgId}` | Public name/logo for the sign-in screen | Functions (settings) |
| `organizations/{orgId}` | Name, logo, `settings` (timezone, accuracy, location age, approval mode, privacy notice, retention) | Functions (sysadmin) |
| `…/members/{uid}` | Employee profile: number, name, email, department, position, classification, supervisor, role, supervised departments, individually authorized workplaces, active flag, accepted privacy-notice version | Functions |
| `…/departments/{id}` | Departments / offices | Functions (HR) |
| `…/workplaces/{id}` | Name, address, lat/lng, radius (m), active, assigned departments and members | Functions (HR) |
| `…/schedules/{id}` | Pattern (single / split), sessions, work days, grace, break window, flexible window, early-in, cutoff, overtime threshold | Functions (HR) |
| `…/scheduleAssignments/{id}` | Member ↔ schedule, `effectiveFrom`/`effectiveTo` | Functions (HR) |
| `…/holidays/{id}`, `…/leaves/{id}` | Holiday calendar; approved full-day leave | Functions (HR) |
| `…/attendanceEvents/{uid_requestId}` | **Immutable** accepted event: member, department, shift instance id, work date, action, official server time (UTC ms), timezone, request id, validation outcome, workplace, distance, accuracy, location age | `clockAttendance` only |
| `…/attendanceLocationEvidence/{eventId}` | Precise coordinates, accuracy, capture time, device clock skew — separated for access control | `clockAttendance` only |
| `…/attendanceAttempts/{id}` | Rejected attempts with reason code (HR review; owner can read) | `clockAttendance` |
| `…/shiftInstances/{uid_workDate}` | Shift state: schedule snapshot (`plan`), effective punches, corrected actions, event ids, version. **Derived and rebuildable.** Also the transaction lock for concurrent submissions. | Functions |
| `…/adjustments/{id}` | **Immutable** approved correction: action, before, after, original event id, reason, reviewer, timestamp, request id | Functions (review / HR) |
| `…/correctionRequests/{id}` | Missing/incorrect punch, explanation, overtime, fieldwork requests with status, reviewer, remarks | Functions |
| `…/fieldworkAuthorizations/{id}` | Approved window + alternate location geofence or explicit exemption; revocable. `category` is `fieldwork` or `wfh` (work from home: geofence at the approved home location) | Functions (review) |
| `…/overtimeApprovals/{id}` | Approved overtime minutes, tracked separately from potential overtime | Functions (review) |
| `…/auditLogs/{id}` | Append-only: actor, role, action, target, before/after, reason, time | Functions |
| `…/rateLimits/{key}` | Throttle windows (no client access) | Functions |

Refinements versus the suggested entity list: `dailyAttendanceSummaries` and `shiftInstances` were merged — the shift instance document holds the derived state, while **reports and dashboards recompute from sources on demand** (`computeRange`), so summaries cannot silently drift. HR can run **Maintenance → Rebuild summaries**, which recomputes shift documents from events + adjustments and reports any drift. `organizationSettings` lives inside the organization document.

## Trusted attendance processing (`clockAttendance`)

1. **Authenticate** and load the member fresh from Firestore (deactivation takes effect immediately even for sessions with a still-valid ID token; the Auth account is also disabled and refresh tokens revoked).
2. **Idempotency:** the event id is `{uid}_{requestId}`. A replayed request returns the original receipt (`replayed: true`) without re-validating; a reused id with a different action is rejected.
3. Privacy notice accepted (current version), **throttle** (12 attempts / 5 min per user).
4. **Location sanity:** present, valid lat/lng, accuracy ≤ `maxAccuracyMeters`, age ≤ `maxLocationAgeSeconds`, not from the future. Age is measured on the device's own clock (`sentAt − capturedAt`) so a phone with a wrong clock is not falsely rejected; the skew is recorded in evidence.
5. **Geofence:** nearest authorized workplace (department or individual assignment, active only) plus approved fieldwork locations; distance via Haversine; boundary counts as inside. The radius is **never** enlarged for poor accuracy. An approved exemption accepts without a geofence match (location is still recorded).
6. **Transaction:** reads the shift documents for local yesterday/today/tomorrow and the idempotency document, re-checks active status, determines the shift and the **next valid action**, and creates the event (`create` fails if it already exists), the evidence and the updated shift. Firestore serializes concurrent transactions on the same shift document, so only one of several simultaneous taps succeeds (verified by tests).
7. Returns a receipt or `{ ok:false, code, message, details }` with a structured rejection code (see `shared/errors.ts`). Rejections are logged to `attendanceAttempts`.

The client stores the pending `requestId` locally before sending. If the network fails, the employee can **Check status** (`attendanceStatus`) or **Retry same request** (same id → no duplicates). Success is only displayed after the server confirms. Nothing is ever queued offline.

## Schedules and calculation policy (assumptions)

All calculations are pure functions in `shared/attendance.ts` and `shared/schedule.ts`, with unit tests.

- **Storage and display:** instants are UTC epoch ms; work dates are calendar dates in the organization timezone (default `Asia/Manila`, configurable; DST-aware conversion via `Intl`).
- **Work date / overnight:** a shift belongs to the date on which it *starts*. Sessions whose end is at or before their start roll into the next day, so `22:00–06:00` on Monday ends Tuesday 06:00 and a 06:05 clock-out is recorded on Monday's shift.
- **Action window:** actions open `earlyInMinutes` before the first session (default 120) and close at `cutoffMinutes` after the last session ends (default 240). Outside the window the employee is told why and directed to corrections.
- **Patterns:** single (`IN`, `OUT`) or split (`AM_IN`, `AM_OUT`, `PM_IN`, `PM_OUT`). Only the next valid action is offered. In split mode, if nothing was recorded and the AM session is over (past the middle of the lunch gap), the next action is `PM_IN`; the missed AM actions become missing actions.
- **Minimum interval:** consecutive actions must be at least `minActionIntervalSeconds` apart (default 60) to prevent accidental double submissions.
- **Minute precision:** punch times are truncated to the minute before computing.
- **Late:** if arrival minute − scheduled start > grace, lateness = arrival − start (counted from the start, not from the end of grace). Per session for split schedules.
- **Flexible schedules:** the first session's start may float up to `flexMinutes`; the expected end moves by the same amount. Lateness is measured after the flex window (+ grace).
- **Undertime:** departure before the (flex-adjusted) session end. A session with no punches at all is reported as *missing actions*, not undertime.
- **Worked minutes:** sum of completed in/out pairs minus overlap with the single-pattern unpaid break window. Split patterns use the natural gap.
- **Potential overtime:** time after the scheduled end once it reaches `overtimeThresholdMinutes` (default 30); on unscheduled days (rest day, holiday, no schedule) all worked time. **It is never auto-approved**; approved overtime comes only from approved overtime requests (`overtimeApprovals`).
- **Work from home:** an approved WFH authorization adds the employee's home location as a geofence for its window (or an exemption). Events are validated as `wfh_location` / `wfh_exemption`; a WFH day without punches shows status `wfh` (exception `WFH_NO_PUNCH` after cutoff), never `absent`. Organization setting `wfhEnabled` controls whether employees can request it.
- **Statuses:** `upcoming`, `awaiting`, `in_progress`, `completed`, `incomplete` (missing actions after cutoff), `absent` (no punches after cutoff, not on leave/holiday/rest day/fieldwork), `leave`, `holiday`, `rest_day`, `no_schedule`, `fieldwork`, `wfh`. **No one is marked absent before their shift cutoff.**
- **Unscheduled attendance:** allowed by default (`allowUnscheduledAttendance`) on rest days, holidays or without a schedule; it is a single in/out pair flagged `UNSCHEDULED_WORK`, with clock-out allowed within `unscheduledMaxHours` (default 16).
- **Holidays** apply to everyone; **leave** is full-day only in this version.
- **Effective-dated assignments:** the assignment with the latest `effectiveFrom` on or before the date wins. Once a shift has started, its schedule **snapshot** is stored on the shift document, so later schedule edits do not rewrite history.
- **Corrections:** effective punches = original events overlaid with approved adjustments (latest per action wins; an adjustment may void an action). Adjustments that would put actions out of time order are refused.
- No payroll deductions are computed.

## Roles and permissions

| Capability | Employee | Supervisor | HR | Sysadmin |
| --- | --- | --- | --- | --- |
| Own profile, schedule, history, requests; clock in/out | ✓ | ✓ | ✓ | ✓ |
| View employees/attendance in supervised departments | | ✓ | all | all |
| Approve/reject requests | | own departments (if approval mode allows) | ✓ | ✓ |
| Manage employees, departments, workplaces, schedules, holidays, leave, adjustments | | | ✓ | ✓ |
| Exact location evidence, rejected attempts, audit log | own evidence | | ✓ | ✓ |
| Organization settings, roles, administrator accounts | | | | ✓ |

Additional guards: nobody may review or adjust their own attendance; HR cannot modify their own assignments or other administrators; the last active system administrator cannot be demoted or deactivated; role changes are sysadmin-only and audited.

## Security model and limitations

- **Location is evidence, not proof.** Browser geolocation is reported by the device. It can be spoofed with developer tools, mock-location apps, or modified browsers. The server validates the *reported* reading; it cannot verify the device was physically present. This app is **not spoof-proof** and **not equivalent to biometric verification**. IP geolocation is not used.
- **No device fingerprinting** and no browser device ID is treated as identity. No selfies, facial recognition, or biometrics.
- **No background tracking:** location is requested only via `getCurrentPosition` when the employee taps an action (`maximumAge: 0`, high accuracy). There is no `watchPosition`.
- **App Check** (optional) reduces automated abuse; it does not prove identity or presence.
- **Rate limiting** is a simple Firestore fixed window per user and operation class.
- **Audit logs** cover role changes, employee changes, activation, schedules, assignments, workplaces, holidays, leave, settings, approvals, adjustments, privacy acknowledgements, summary rebuilds and retention runs.
- **Retention:** destructive deletion is disabled by default. When enabled, the daily job deletes only rejected attempts and precise location evidence older than the configured periods; accepted events, adjustments and audit logs are kept.
- **Exports** do not include coordinates. Supervisors see workplace name and distance, not coordinates.

## Scalability notes

Reports and the daily monitor read members, schedules, assignments and shifts for the requested range and compute in memory (62-day limit). This is appropriate for organizations up to a few hundred employees. For much larger organizations, add pagination by department and a scheduled job that materializes daily summaries (the rebuild routine already exists).
