import { logger } from 'firebase-functions/v2';
import { col, db, withDefaults } from './context';

/**
 * Deletes rejected attempts and precise location evidence older than the
 * configured retention periods. Disabled by default: an organization must
 * explicitly set settings.retention.enabled = true. Accepted attendance events,
 * adjustments and audit logs are never deleted by this job.
 */
export async function runRetention(now = Date.now()) {
  const orgs = await db.collection('organizations').get();
  const results: Record<string, { attempts: number; evidence: number } | 'disabled'> = {};
  for (const org of orgs.docs) {
    const settings = withDefaults(org.get('settings'));
    if (!settings.retention.enabled) {
      results[org.id] = 'disabled';
      continue;
    }
    const attempts = await deleteOlderThan(col(org.id, 'attendanceAttempts'), 'at', now - settings.retention.rejectedAttemptDays * 86_400_000);
    const evidence = await deleteOlderThan(col(org.id, 'attendanceLocationEvidence'), 'receivedAt', now - settings.retention.locationEvidenceDays * 86_400_000);
    results[org.id] = { attempts, evidence };
    const ref = col(org.id, 'auditLogs').doc();
    await ref.set({ orgId: org.id, actorUid: 'system', actorName: 'Retention job', actorRole: 'system', action: 'retention.run', targetType: 'organization', targetId: org.id, before: null, after: { attempts, evidence }, reason: null, at: now });
  }
  logger.info('retention complete', results);
  return results;
}

async function deleteOlderThan(ref: FirebaseFirestore.CollectionReference, field: string, cutoff: number) {
  let total = 0;
  for (;;) {
    const snap = await ref.where(field, '<', cutoff).limit(400).get();
    if (snap.empty) return total;
    const batch = db.batch();
    snap.docs.forEach((d) => batch.delete(d.ref));
    await batch.commit();
    total += snap.size;
  }
}
