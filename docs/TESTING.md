# Verification results, manual checklist, and known limitations

## Automated verification performed (2026-11-08, Linux container)

All runs below were executed in this repository's development container against the **Firebase Emulator Suite** (firebase-tools 14, Java 21). No production project, real phone, or Netlify deployment was used.

| Check | Command | Result |
| --- | --- | --- |
| Type check (frontend + shared + tooling) | `npm run typecheck` | ✅ pass, 0 errors |
| Type check (functions) | `npm --prefix functions run typecheck` | ✅ pass, 0 errors |
| Lint | `npm run lint` | ✅ pass, 0 errors, 0 warnings |
| Unit tests (shared engine, CSV) | `npm test` | ✅ 45 / 45 passed |
| Backend integration tests (Auth + Firestore emulators) | `npm run test:functions` | ✅ 34 / 34 passed |
| Firestore security-rules tests | `npm run test:rules` | ✅ 8 / 8 passed (≈40 assertions) |
| Production build | `npm run build` | ✅ built; main JS ≈83 kB gzip, Firebase SDK chunk ≈171 kB gzip |
| End-to-end smoke test (Playwright Chromium, phone viewport, emulated geolocation, Auth/Firestore/Functions emulators, Vite dev server) | `npm run test:e2e` | ✅ 16 / 16 checks passed |

### What the automated tests cover

| Requirement | Where |
| --- | --- |
| Inside / outside geofence | `shared/__tests__/geo.test.ts`, `functions/test/attendance.test.ts` |
| Boundary distance (99.4 m in / 100.6 m out of 100 m) and poor accuracy (rejected; never enlarges radius; exactly-at-limit accepted) | both of the above |
| Stale, future-dated, missing and invalid locations; device clock skew tolerance | `functions/test/attendance.test.ts` |
| Invalid sequences (OUT before IN, double IN, too soon, shift complete) | `functions/test/attendance.test.ts`, `shared/__tests__/attendance.test.ts` |
| Duplicate requests (same id replay returns original receipt; reused id with different action rejected) | `functions/test/attendance.test.ts` |
| Concurrent submissions (5 simultaneous different ids → exactly 1 event; 4 simultaneous same id → 1 event) | `functions/test/attendance.test.ts` |
| Overnight shifts (after-midnight clock-out and late after-midnight clock-in assigned to start date; overnight break) | both attendance test files |
| Grace periods (minute precision), break deduction, undertime, split sessions, flexible start, potential overtime threshold | `shared/__tests__/attendance.test.ts` |
| Absence only after cutoff; leave/holiday/rest day/fieldwork distinguished | `shared/__tests__/attendance.test.ts` |
| Inactive accounts (clock-in rejected, API rejected, data reads denied by rules, sign-in blocked) | functions tests, rules tests, e2e |
| Unauthorized record access (no client writes; own-record reads only; coordinates restricted) | `tests/firestore.rules.test.ts`, `functions/test/workflows.test.ts` |
| Department-scoped supervisor access (rules, reports, monitor, review, day detail) | rules tests, workflows tests, e2e |
| Prevention of self-approval and self-adjustment (including HR) | `functions/test/workflows.test.ts` |
| Duplicate processing of approvals (two concurrent approvals → one adjustment) | `functions/test/workflows.test.ts` |
| Correction audit history (original preserved, adjustment before/after/reviewer/reason, audit log, rebuild finds no drift, report marks corrected) | `functions/test/workflows.test.ts` |
| Organization isolation (rules and backend) | rules tests, `functions/test/attendance.test.ts` |
| Role management (sysadmin only, no self-change, last sysadmin protected, audited) | `functions/test/workflows.test.ts` |
| Fieldwork exemption and alternate-location authorization | `functions/test/attendance.test.ts`, workflows tests |
| Throttling | `functions/test/attendance.test.ts` |
| UI: privacy notice on first login, next-action button, accuracy/distance review, receipt, double-submit guard, offline banner, outside-geofence warning, permission-denied instructions + retry, history, request submission, supervisor dashboard & approval, HR report & audit log, inactive sign-in | `e2e/smoke.mjs` |

Screenshots from the e2e run are in `docs/screenshots/`.

### Not verified here

- **No physical Android or iPhone testing** was performed. Geolocation in the e2e test is emulated by Playwright; real GPS accuracy, permission prompts, and Safari/Chrome behavior must be checked on devices.
- **No deployment** to Firebase or Netlify was performed (no credentials). Composite indexes, App Check, the scheduled retention job, password-reset emails from production, and the Netlify CSP headers are therefore untested in production. The Firestore emulator does not enforce composite indexes.
- Service-worker installability was not tested in a real browser install flow (the dev server does not register the service worker).
- Accessibility was addressed by design (labels, focus styles, 44 px+ targets, text + icon status badges, contrast-checked palette) but no formal audit (e.g. screen reader walkthrough) was done.

## Manual testing checklist (physical phones)

Run on at least one **Android phone with Chrome** and one **iPhone with Safari**, against a deployed staging environment (HTTPS is required for geolocation). Record device model, OS and browser versions.

| # | Scenario | Android Chrome | iPhone Safari |
| --- | --- | --- | --- |
| 1 | Sign in; "Keep me signed in" off → closing the tab signs out | ☐ | ☐ |
| 2 | Password reset email arrives and works | ☐ | ☐ |
| 3 | First-login privacy notice appears once; re-appears after the notice version changes | ☐ | ☐ |
| 4 | Clock In at the workplace: explanation → browser prompt → Allow → accuracy & distance shown → receipt with server time | ☐ | ☐ |
| 5 | Button immediately shows Clock Out but is blocked for ~60 s with an explanation | ☐ | ☐ |
| 6 | **Permission denied:** deny the prompt → instructions for this platform → enable in settings → Retry succeeds | ☐ | ☐ |
| 7 | **Location services off** (system level) → "could not be determined" guidance → turn on → Retry | ☐ | ☐ |
| 8 | **GPS timeout / poor accuracy** indoors (basement) → retry required, never accepted silently | ☐ | ☐ |
| 9 | **Outside geofence** (≥ radius + 50 m away) → warning, cannot submit; HR sees nothing recorded | ☐ | ☐ |
| 10 | **Offline:** airplane mode → offline banner, button disabled; nothing is recorded after reconnecting | ☐ | ☐ |
| 11 | **Network drop during submit:** enable airplane mode right after tapping Submit → "Not yet confirmed" → reconnect → Check status / Retry same request → exactly one record | ☐ | ☐ |
| 12 | Rapid double tap on Submit → one record | ☐ | ☐ |
| 13 | **Install:** Android "Install app"; iPhone Share → Add to Home Screen; app opens standalone with icon; location prompt works in installed mode | ☐ | ☐ |
| 14 | After install, offline launch shows the app shell and offline message (no employee data cached) | ☐ | ☐ |
| 15 | Split schedule: AM In, AM Out, PM In, PM Out appear in order | ☐ | ☐ |
| 16 | Overnight shift: clock in before midnight, clock out after → one record on the start date | ☐ | ☐ |
| 17 | Correction request submitted, approved by supervisor, shown as "Corrected" in history and reports | ☐ | ☐ |
| 18 | Fieldwork request approved; clock in at the alternate site works only within the window | ☐ | ☐ |
| 19 | Deactivate an employee while they are signed in → next action and data access are blocked | ☐ | ☐ |
| 20 | Admin console usable on phone (tables become cards; navigation scrolls) | ☐ | ☐ |
| 21 | Print monthly time record from a desktop browser (A4/Letter) | ☐ desktop | |
| 22 | Large text / zoom 200% remains usable; VoiceOver/TalkBack reads buttons and statuses | ☐ | ☐ |

## Known limitations

- **Location can be spoofed.** Geofencing is supporting evidence only; this is not proof of presence or a biometric control. No IP geolocation is used.
- Leave is recorded as full days by HR; there is no leave filing/balance workflow.
- Holidays apply organization-wide (no regional holidays).
- Flexible schedules float only the first session's start.
- Missing whole sessions are reported as missing actions, not undertime.
- Reports compute on demand (62-day limit); very large organizations should add materialized daily summaries (see ARCHITECTURE.md).
- Organization logo is stored inline (≤200 KB) or as an https URL; there is no file storage bucket.
- The monthly layout is DTR-style and not an official Civil Service Form 48.
- The rate limiter is a simple per-user Firestore window, not a distributed abuse-prevention system.
- No payroll calculations or deductions.
