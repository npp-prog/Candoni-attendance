# Setup and deployment

This guide covers local development, the Firebase project, deploying the backend to Firebase, deploying the frontend to Netlify, and creating the first administrator securely.

**Status of this repository:** the application was built and verified against the Firebase Emulator Suite. The frontend is configured for Firebase project `candoni-attendance-813a0`, but **nothing has been deployed** yet (no deploy credentials were available to the developer). Steps 4–9 below are what remains.

## 1. Prerequisites

- Node.js 22 and npm
- Java 21+ (only for running the Firestore emulator locally)
- Firebase CLI — installed as a dev dependency (`npx firebase ...`)
- A Google account with permission to create Firebase projects
- A Netlify account

## 2. Paid services and external credentials

| Service | Required? | Cost notes |
| --- | --- | --- |
| Firebase **Blaze (pay-as-you-go)** plan | **Yes** | Cloud Functions (2nd gen) require Blaze. Functions, Cloud Build, Artifact Registry and Cloud Scheduler (used by the daily retention job) bill above free quotas. A small organization usually stays within or near free tiers, but **set a budget alert** in Google Cloud Billing. |
| Cloud Firestore | Yes | Free daily quota, then per read/write/storage. Reports compute on demand and read many documents; keep report ranges reasonable. |
| Firebase Authentication (email/password) | Yes | Free for email/password at typical volumes. Built-in password-reset emails are free. |
| Firebase App Check with **reCAPTCHA Enterprise** | Recommended | reCAPTCHA Enterprise has a free monthly assessment allowance; beyond it is billed. Requires a reCAPTCHA Enterprise site key. |
| Netlify | Yes (frontend) | Free tier is sufficient for a static SPA. |
| Maps | No key needed | Workplace previews use an OpenStreetMap embed and plain links to OpenStreetMap / Google Maps. Respect the [OSM tile usage policy](https://operations.osmfoundation.org/policies/tiles/) (light, interactive use only). No Google Maps API key is used. |

No credentials are committed. The Firebase **web config** (`VITE_FIREBASE_*`) is not a secret; it identifies the project. Security comes from Firestore rules, backend authorization, and App Check. Server-only configuration lives in `functions/.env` (non-secret) and, if you add secrets later, Cloud Secret Manager via `defineSecret` — never in the frontend.

## 3. Local development (emulators)

```bash
npm install && npm --prefix functions install
cp .env.development.example .env.development.local
npm run emulators:fresh   # Auth 9099, Firestore 8080, Functions 5001, UI 4000
npm run seed              # DEV-ONLY seed data; forces emulator hosts and a demo- project id
npm run dev               # http://127.0.0.1:5173
```

To test on a phone on the same Wi-Fi network you need HTTPS (browsers only allow geolocation on secure origins, except `localhost`). Use a tunnel (for example `npx localtunnel` or Cloudflare Tunnel) or deploy a preview. The emulators must then also be reachable from the phone; deploying to a real Firebase *staging* project is usually simpler for phone testing.

## 4. Create the Firebase project

1. In the [Firebase console](https://console.firebase.google.com/), create a project (e.g. `candoni-attendance`). Upgrade it to **Blaze**.
2. **Authentication → Sign-in method:** enable **Email/Password**. Do **not** enable email-link sign-up for the public. If your project has the **Settings → User actions** panel (available with Firebase Authentication with Identity Platform), disable "Enable create (sign-up)" so the client SDK cannot self-register. Even without it, a self-created Auth account has no organization link or member profile, so Firestore rules and every backend function deny it all data and actions; accounts only become employees when an administrator creates them.
3. **Authentication → Settings → Authorized domains:** add your Netlify domain(s) (e.g. `candoni-attendance.netlify.app` and any custom domain).
4. **Authentication → Templates:** customize the password-reset email sender name (used for account invitations and password resets).
5. **Firestore Database:** create in **Native mode**, location **`asia-southeast1` (Singapore)** — closest to Manila and matching the functions region. The location cannot be changed later.
6. **Project settings → Your apps:** add a **Web app**. Its config for project **`candoni-attendance-813a0`** is already committed in `.env.production` (used by `npm run build`; Netlify variables with the same names override it).
7. `.firebaserc` already defines the alias `prod` → `candoni-attendance-813a0` (the default stays `demo-candoni` for emulators). Log in once:
   ```bash
   npx firebase login
   ```
   Always pass `--project prod` for real deployments.
8. Recommended: in Google Cloud console → **APIs & Services → Credentials**, restrict the browser API key with **HTTP referrers** (your Netlify domain(s) and `candoni-attendance-813a0.firebaseapp.com`).

## 5. Deploy the backend (rules, indexes, functions)

```bash
cp functions/.env.example functions/.env    # FUNCTIONS_REGION=asia-southeast1, ENFORCE_APP_CHECK=false initially
npx firebase deploy --project prod --only firestore:rules,firestore:indexes,functions
```

- The first functions deploy enables Cloud Build, Artifact Registry, Cloud Run, Eventarc and Cloud Scheduler APIs; accept the prompts.
- Index builds can take several minutes. Queries needing an index fail until it finishes.
- Set an **artifact cleanup policy** when the CLI asks, to avoid storage charges for old container images.
- Region must match `VITE_FUNCTIONS_REGION` in the web app.

## 6. Create the first system administrator (secure bootstrap)

There is no public registration. The first administrator is created once, from a trusted machine, with Google Cloud credentials that have Firebase Admin access:

```bash
gcloud auth application-default login       # or export GOOGLE_APPLICATION_CREDENTIALS=/secure/path/key.json
npm run bootstrap-admin -- --project <project-id> --org candoni \
  --org-name "Candoni Accounting" --email admin@your-org.example \
  --full-name "Jane Admin" --employee-number ADM-0001 --timezone Asia/Manila
```

The script:
- creates the organization (`organizations/candoni`) and its public branding document,
- creates the Auth user with a random password it never prints,
- links the user and creates a **System Administrator** member profile,
- writes an audit-log entry,
- prints a **one-time password setup link** — send it to the administrator through a trusted channel,
- **refuses to run** if the organization already has an active system administrator.

Then delete any downloaded service-account key. All further accounts are created in the app (Employees → Add employee); the new employee receives the standard Firebase password-reset email to set their password, and HR can also copy a one-time setup link.

`--org` must equal `VITE_ORG_ID` in the web app (default `candoni`).

## 7. Deploy the frontend to Netlify

1. Create a Netlify site from this repository (or `npx netlify deploy`). `netlify.toml` already sets the build command (`npm run build`), publish directory (`dist`), Node 22, SPA routing, and security headers (including a Content-Security-Policy and `Permissions-Policy: geolocation=(self)`).
2. Environment variables: the Firebase web config is already in `.env.production`, so no Netlify variables are required. To change a value (e.g. add `VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY`), set it in **Site configuration → Environment variables**; those override the file. **Never set `VITE_USE_EMULATORS=true` in production.**
3. Deploy. Add the Netlify domain to Firebase Auth authorized domains (step 4.3).
4. If you use a custom logo URL, it must be `https://`. If you change the CSP, keep `connect-src` covering `*.googleapis.com`, `*.cloudfunctions.net` and `*.run.app`.

## 8. Firebase App Check (recommended)

App Check attests that calls come from your web app, reducing scripted abuse. It **does not** prove who the user is or where the device is, and determined attackers can still run a real browser.

1. Google Cloud console → **reCAPTCHA Enterprise**: create a **website key** for your Netlify domain(s) (score-based, no checkbox).
2. Firebase console → **App Check** → your web app → register with **reCAPTCHA Enterprise** using that key.
3. Set `VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY` in Netlify and redeploy the frontend.
4. Watch App Check metrics for a few days. When verified traffic is ~100%, set `ENFORCE_APP_CHECK=true` in `functions/.env` and redeploy functions. In the Firebase console you can also enforce App Check for Firestore.

Limitations: older browsers or strict privacy/ad-blocking setups may fail reCAPTCHA; enforcement then blocks those users. App Check is skipped automatically when using emulators.

## 9. After deployment

- Sign in as the administrator, accept the privacy notice, open **Settings**: confirm organization name, logo, timezone (default `Asia/Manila`), accuracy (default 100 m), location age (default 60 s), approval workflow and privacy notice text.
- Add departments, workplaces (verify each on the map), schedules, holidays, then employees and schedule assignments.
- Perform the [manual phone checklist](TESTING.md#manual-testing-checklist-physical-phones) on real Android and iPhone devices before rollout.
- Configure a Google Cloud **budget alert**.
- Retention deletion is disabled by default; enable it in Settings only after agreeing a policy.

## Environment variable reference

| Variable | Where | Purpose |
| --- | --- | --- |
| `VITE_FIREBASE_*` | Netlify / `.env` | Firebase web app config |
| `VITE_ORG_ID` | Netlify / `.env` | Organization used for sign-in branding |
| `VITE_FUNCTIONS_REGION` | Netlify / `.env` | Region of deployed functions (`asia-southeast1`) |
| `VITE_APPCHECK_RECAPTCHA_ENTERPRISE_KEY` | Netlify / `.env` | Enables App Check in the client |
| `VITE_USE_EMULATORS` | `.env.development.local` only | Connect to local emulators |
| `FUNCTIONS_REGION` | `functions/.env` | Deployment region |
| `ENFORCE_APP_CHECK` | `functions/.env` | Require App Check tokens on callables |

## Production notes for candoni-attendance-813a0

- Firestore uses the **named database `candoni-attendance`** (asia-southeast1). Mapping: `.firebaserc` target `main` → `candoni-attendance` for this project; `functions/.env.candoni-attendance-813a0` sets `FIRESTORE_DATABASE_ID`; `.env.production` sets `VITE_FIRESTORE_DATABASE_ID`. The emulators keep using `(default)`.
- The Firebase CLI auto-created an empty `(default)` database during the first rules deploy. It has no rules release (all client access denied) and is unused.
- **Build service account permissions:** in this Google Workspace organization the Compute Engine default service account (`64568184628-compute@developer.gserviceaccount.com`) has no roles, so function builds fail. Grant it (least privilege):
  ```bash
  SA=serviceAccount:64568184628-compute@developer.gserviceaccount.com
  for R in roles/cloudbuild.builds.builder roles/datastore.user roles/firebaseauth.admin roles/logging.logWriter; do
    gcloud projects add-iam-policy-binding candoni-attendance-813a0 --member=$SA --role=$R --condition=None
  done
  ```
  Then redeploy: `npx firebase deploy --project prod --only functions --force`.
- If the organization enforces **Domain restricted sharing** (`iam.allowedPolicyMemberDomains`), the deploy cannot make the callable functions publicly invokable (`allUsers`), and the web app will get permission errors. Allow an exception for this project or ask your Workspace admin.
- Bootstrap command used: `node scripts/bootstrap-admin.mjs --project candoni-attendance-813a0 --database candoni-attendance --org candoni ...`

- **Custom domain:** the app is served at `https://clockup.mgocandoni.com` (Netlify custom domain). It is listed first in `WEBAUTHN_ORIGINS` (functions/.env.candoni-attendance-813a0) so phones register to it. Add it to Firebase **Authentication → Settings → Authorized domains** as well.
- **Web API key restriction (applied 2026-11-09):** the Firebase browser key is limited to these websites: `https://clockup.mgocandoni.com/*`, `https://candoni-attendance.netlify.app/*`, `https://candoni-attendance-813a0.firebaseapp.com/*`, `https://candoni-attendance-813a0.web.app/*`, keeping its existing Firebase-only API list. If you serve the app from a new address, add it in Google Cloud console → APIs & Services → Credentials → *Browser key (auto created by Firebase)* → Website restrictions. The key is public by design (it ships in the web app); GitHub secret-scanning alerts for it can be closed as "Won't fix".
- **Schedule:** all employees use *Regular AM/PM* (AM 08:00–12:00, PM 13:00–17:00, Mon–Fri, 15-minute grace) from 2026-11-09.
