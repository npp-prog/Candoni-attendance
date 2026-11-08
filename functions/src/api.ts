import { HttpsError } from 'firebase-functions/v2/https';
import { z } from 'zod';
import * as admin from './admin';
import { myToday } from './attendance';
import { audit, db, enforceRateLimit, loadCaller, col, type Caller } from './context';
import { dailyMonitor, dayDetail, myHistory, runReport } from './reports';
import { cancelRequest, reviewRequest, submitRequest } from './requests';

type Handler = (caller: Caller, data: unknown) => Promise<unknown>;

async function acceptPrivacy(caller: Caller, raw: unknown) {
  const { version } = z.object({ version: z.number().int().min(1) }).parse(raw);
  if (version !== caller.org.settings.privacyNoticeVersion) throw new HttpsError('failed-precondition', 'The privacy notice was updated. Please review the latest version.');
  const batch = db.batch();
  batch.update(col(caller.orgId, 'members').doc(caller.uid), { privacyAcceptedVersion: version, privacyAcceptedAt: Date.now() });
  audit(batch, caller, { action: 'privacy.accept', targetType: 'member', targetId: caller.uid, after: { version } });
  await batch.commit();
  return { ok: true };
}

/** Every operation performs its own role/scope checks on the server. */
export const OPS: Record<string, Handler> = {
  'me.today': (c) => myToday(c),
  'me.history': myHistory,
  'me.acceptPrivacy': acceptPrivacy,
  'day.detail': dayDetail,
  'request.submit': submitRequest,
  'request.cancel': cancelRequest,
  'request.review': reviewRequest,
  'employee.create': admin.createEmployee,
  'employee.update': admin.updateEmployee,
  'employee.setActive': admin.setEmployeeActive,
  'employee.setRole': admin.setRole,
  'employee.resetLink': admin.resetLink,
  'department.upsert': admin.upsertDepartment,
  'workplace.upsert': admin.upsertWorkplace,
  'schedule.upsert': admin.upsertSchedule,
  'assignment.create': admin.createAssignment,
  'assignment.end': admin.endAssignment,
  'holiday.upsert': admin.upsertHoliday,
  'holiday.delete': (c, d) => admin.deleteRecord(c, d, 'holidays'),
  'leave.upsert': admin.upsertLeave,
  'leave.delete': (c, d) => admin.deleteRecord(c, d, 'leaves'),
  'fieldwork.revoke': admin.revokeFieldwork,
  'adjustment.create': admin.createAdjustment,
  'settings.update': admin.updateSettings,
  'summaries.rebuild': admin.rebuildSummaries,
  'monitor.daily': dailyMonitor,
  'report.run': runReport,
};

const READ_OPS = new Set(['me.today', 'me.history', 'day.detail', 'monitor.daily', 'report.run']);

export async function handleApi(uid: string | undefined, raw: unknown) {
  const parsed = z.object({ op: z.string().max(64), data: z.unknown().optional() }).safeParse(raw);
  if (!parsed.success || !OPS[parsed.data.op]) throw new HttpsError('invalid-argument', 'Unknown operation.');
  const { op, data } = parsed.data;
  const caller = await loadCaller(uid);
  await enforceRateLimit(caller.orgId, `api_${READ_OPS.has(op) ? 'r' : 'w'}_${caller.uid}`, READ_OPS.has(op) ? 120 : 40, 60);
  try {
    return await OPS[op](caller, data ?? {});
  } catch (e) {
    if (e instanceof z.ZodError) throw new HttpsError('invalid-argument', e.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; '));
    throw e;
  }
}
