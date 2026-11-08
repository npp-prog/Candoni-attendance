# Candoni Attendance

A mobile-first employee attendance web app (PWA). Employees sign in on their own phones, capture a fresh location only when they tap **Clock In / Clock Out**, and a trusted Cloud Function validates the request (employee status, schedule, next valid action, accuracy, location age, geofence) before recording it with a server timestamp. Supervisors and HR manage employees, workplaces, schedules, corrections, fieldwork and reports.

The organization name and logo are configurable (Settings → Branding). "Candoni Attendance" is the working name.

> **Important limitation:** browser location is supplied by the device and can be spoofed. Server-side geofence validation is supporting evidence, **not proof of physical presence**, and this app is not equivalent to biometric verification. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md#security-model-and-limitations).

## Stack

| Layer | Technology |
| --- | --- |
| Frontend | React 19, TypeScript, Vite, Tailwind CSS 4, PWA (manifest + shell-only service worker) |
| Auth | Firebase Authentication (email/password, admin-created accounts only) |
| Data | Cloud Firestore (organization-scoped, read-only rules for clients) |
| Backend | Cloud Functions for Firebase (2nd gen, Node 22) — all writes |
| Hosting | Netlify (frontend only) |
| Shared logic | `shared/` — dependency-free TypeScript used by both frontend and functions |

## Repository layout

```
shared/            Domain engine: geofence (Haversine), timezone math, schedules,
                   overnight shifts, next-action sequencing, daily calculations, roles
functions/         Cloud Functions: clockAttendance, attendanceStatus, api, retentionJob
  src/             Trusted processing, admin/review/report operations, audit logging
  test/            Emulator integration tests
src/               React app (employee screens + admin console)
tests/             Firestore security-rules tests (emulator)
e2e/               Playwright end-to-end smoke test (emulators + dev server)
scripts/           Emulator seed data, production admin bootstrap, icon generation
firestore.rules    Least-privilege, read-only client rules
firestore.indexes.json
netlify.toml       Netlify build, SPA routing, security headers
docs/              Setup, architecture, guides, verification
```

## Quick start (local, emulators — no credentials needed)

Requirements: Node 22, Java 21+ (for the Firestore emulator).

```bash
npm install
npm --prefix functions install
cp .env.development.example .env.development.local

npm run emulators:fresh        # terminal 1: Auth, Firestore, Functions, Emulator UI (http://127.0.0.1:4000)
npm run seed                   # terminal 2: DEV seed data (clearly labeled)
npm run dev                    # terminal 2: http://127.0.0.1:5173
```

Sign in with a seeded account such as `employee@candoni.dev` (password printed by the seed script). Use Chrome DevTools → **More tools → Sensors** to set the location to the Main Office sample coordinates (14.5896, 120.9811).

## Commands

| Command | Purpose |
| --- | --- |
| `npm run typecheck` / `npm run lint` | Type-check and lint (frontend, shared, functions sources) |
| `npm test` | Unit tests for the shared engine and utilities |
| `npm run test:functions` | Backend integration tests on the Auth + Firestore emulators |
| `npm run test:rules` | Firestore security-rules tests on the emulator |
| `npm run test:e2e` | End-to-end smoke test (needs emulators + `npm run dev` running) |
| `npm run build` | Production build to `dist/` |
| `npm run check` | Typecheck, lint, unit tests, functions typecheck, build |

## Documentation

- [docs/SETUP.md](docs/SETUP.md) — Firebase project, credentials, paid services, App Check, deployment to Firebase + Netlify, **secure initial administrator setup**
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — data model, attendance processing, calculation policy assumptions, security model and limitations
- [docs/ADMIN_GUIDE.md](docs/ADMIN_GUIDE.md) — for HR, supervisors and system administrators
- [docs/EMPLOYEE_GUIDE.md](docs/EMPLOYEE_GUIDE.md) — for employees
- [docs/TESTING.md](docs/TESTING.md) — verification results, manual phone checklist, known limitations
