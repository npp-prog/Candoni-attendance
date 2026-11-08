import { setGlobalOptions } from 'firebase-functions/v2';
import { onCall } from 'firebase-functions/v2/https';
import { onSchedule } from 'firebase-functions/v2/scheduler';
import { handleApi } from './api';
import { attendanceRequestStatus, processClock } from './attendance';
import { runRetention } from './retention';

setGlobalOptions({
  region: process.env.FUNCTIONS_REGION || 'asia-southeast1',
  maxInstances: 20,
});

// App Check enforcement is opt-in so local emulators and first deployments work.
// Set ENFORCE_APP_CHECK=true in functions/.env after configuring App Check (docs/SETUP.md).
const enforceAppCheck = process.env.ENFORCE_APP_CHECK === 'true';

/** Trusted attendance submission. Returns a receipt or a structured rejection. */
export const clockAttendance = onCall({ enforceAppCheck, memory: '256MiB', timeoutSeconds: 30 }, (req) =>
  processClock(req.auth?.uid, req.data),
);

/** Lets the app confirm whether a request sent before a network failure was recorded. */
export const attendanceStatus = onCall({ enforceAppCheck, memory: '256MiB' }, (req) => attendanceRequestStatus(req.auth?.uid, req.data));

/** Dispatcher for self-service, review, administration and reporting operations. */
export const api = onCall({ enforceAppCheck, memory: '512MiB', timeoutSeconds: 120 }, (req) => handleApi(req.auth?.uid, req.data));

/** Daily retention job. Deletes nothing unless retention is explicitly enabled in settings. */
export const retentionJob = onSchedule({ schedule: 'every day 02:30', timeZone: 'Asia/Manila' }, async () => {
  await runRetention();
});
