# Administrator guide

For HR / attendance administrators, supervisors (department heads), and system administrators. Open **Admin console →** from the top of the app.

## First-time setup (HR / system administrator)

1. **Settings** (system administrator): organization name, short name, logo (https URL or upload ≤200 KB), timezone (default Asia/Manila), maximum accuracy (default 100 m), maximum location age (default 60 s), approval workflow, privacy notice, retention.
2. **Departments:** add each department or office.
3. **Workplaces:** add each authorized location with coordinates and radius. Use **Use my current location** while standing at the site, or paste coordinates (in Google Maps, long-press the building). **Verify the marker on the map preview.** Assign departments; individual employees can also be authorized from their profile. A typical building radius is 50–150 m. The radius is never enlarged automatically for poor GPS.
4. **Schedules:** create schedules — one clock-in/out or AM/PM pattern; an end time earlier than the start means an overnight shift. Set grace period, unpaid break, early clock-in window, cutoff (after which missing entries and absences are determined), overtime threshold and optional flexible start.
5. **Holidays & leave:** add the holiday calendar (verify official proclamations each year) and record approved full-day leave.
6. **Employees → Add employee:** enter the profile. The employee receives a password-setup email; you can also copy a one-time setup link to share securely. Then open the employee and **assign a schedule** with an effective date.

There is no public sign-up. Only administrators create accounts.

## Daily monitoring

**Dashboard** shows, for a date and department: expected today, clocked in, late, completed, incomplete, approved fieldwork, and absent. Employees without punches show as *Awaiting clock-in* until their shift cutoff; only then are they counted absent. Tap an employee to see original events, any adjustments, and requests. HR sees exact coordinates with a map link; supervisors see workplace and distance only.

## Approvals

**Approvals** lists requests (pending by default) with filters. Supervisors see their departments; HR sees all.

- **Missing / incorrect attendance:** approving creates a separate **adjustment** (before → after, your name, reason). The original event is never changed.
- **Fieldwork:** approving creates an authorization for the requested window, either at an alternate site geofence or with a location exemption. Revocations are audited.
- **Work from home:** the employee pins their home location (or requests an exemption). Check the pin with the *map* link before approving. Approval creates a work-from-home authorization for the window; attendance inside it is labelled *Work from home* in the dashboard, history and reports. Turn WFH requests on or off in **Settings → Attendance policy**.
- **Overtime:** employees must file an overtime request to get the **Overtime In / Overtime Out** clock (a pending request is enough to clock; approval can come later). Approving sets the cap: approved overtime = clocked overtime up to the requested minutes. Reports show clocked overtime, the request status (pending / approved / not approved) and approved minutes. Without the overtime clock, approved minutes are used as requested. *Potential overtime* (staying after the scheduled end without the overtime clock) is shown separately and is never approved automatically.
- **Explanations:** acknowledge or reject; they do not change attendance.

You cannot review your own requests. A request can only be processed once. Rejections require a reason. When **Settings → Approval workflow** is *HR only*, supervisors can view but not approve.

HR can also record an **authorized adjustment** directly from a day's detail (reason required; cannot adjust own attendance).

## Registered phones (prevent clocking in for a coworker)

**Settings → Registered phones** controls whether employees must clock in from their own registered phone, confirmed with the phone's fingerprint, face or PIN (a passkey):

- **Off** (default) — nothing changes.
- **Pilot** — only employees you mark on their profile (*Employees → name → Registered phones → Require a registered phone*).
- In Pilot and Required modes, **anyone who has registered a phone must always confirm on it** — registering a phone can never be bypassed by using another phone.
- **Required for everyone.**

How it works: the employee registers their phone once (*Profile → Registered phone*). The phone keeps a private key that cannot be copied; ClockUp stores only the public key and never receives fingerprints, faces or PINs. Each clock-in asks the phone for its screen lock and sends a one-time signature.

- If someone signs in to a coworker's account on **their own phone**, the clock-in is refused, because that phone isn't the account's registered phone.
- A phone already registered to one employee **cannot be registered to another**.
- The first phone can be approved automatically (setting). **Replacement phones always need HR approval**; they appear at the top of **Approvals**. Approving retires the old phone. Confirm in person that the new phone belongs to the employee. You cannot approve your own phone.
- HR can **revoke** a phone (lost, stolen, shared) from the employee page; revocations are audited.
- **Reports → Suspicious activity (shared phones)** (HR only) flags clock actions from a phone other than the employee's registered phone, Clock In and Clock Out of one shift on different phones, one phone used for several employees, different employees clocking on the same phone within 15 minutes, repeated failed phone checks, and pending registrations. These are prompts to check, not proof.

Limits: if an absent employee hands over **both** their phone and its PIN, no app can tell. Passkeys may sync to the employee's other devices through their own Google/Apple account (shown on the phone record). Phones are registered to the app's web address — if you rename the Netlify site, phones must be registered again (and the new address must be added to `WEBAUTHN_ORIGINS` in `functions/.env.<project>`). Employees whose phone has no screen lock or a very old browser cannot register; turn the requirement off for them (pilot mode) or ask them to set a screen lock.

## Employees

Search, filter by department and status, paginate. On an employee page:
- **Edit** profile, supervisor, individually authorized workplaces.
- **Schedule assignments:** add effective-dated assignments; end a current one, or remove one that has not started.
- **Deactivate** (with reason): the account is disabled, sessions are revoked, and every backend call and data read is blocked immediately. Reactivate the same way.
- **Generate password setup/reset link.**
- **Role & access** (system administrator only): employee, supervisor (choose supervised departments), HR, system administrator. You cannot change your own role, and the last active system administrator cannot be removed.

## Reports

Choose a report, date range (≤62 days), department, employee and status, then **Generate**. Export **CSV** or **Print**.

- Daily attendance · Individual monthly time record (DTR-style, printable with signature lines) · Department summary · Late and undertime summary · Missing attendance and absences · Approved correction history · Fieldwork & work-from-home attendance.
- Corrected records are marked "Corrected" / `*`. Exports never include precise coordinates.
- The monthly layout is DTR-style and **is not an official Civil Service Form 48**.

## Audit & attempts (HR / system administrator)

- **Audit log:** every privileged change with actor, before/after and reason.
- **Rejected attempts:** clock-in/out attempts the server refused, with reason codes (e.g. `OUTSIDE_GEOFENCE`, `LOCATION_INACCURATE`). Useful for spotting wrong workplace coordinates or employees who need help.

## Maintenance

**Rebuild summaries** recomputes shift summaries from immutable events and adjustments for a date range and reports any drift.

## Important limitation

Location readings come from the employee's device and can be spoofed. Treat geofence results as supporting evidence and follow up on patterns that look wrong.
