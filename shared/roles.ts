import type { MemberDoc, Role } from './types';

export const ROLE_LABELS: Record<Role, string> = {
  employee: 'Employee',
  supervisor: 'Supervisor / Department Head',
  hr: 'HR / Attendance Administrator',
  sysadmin: 'System Administrator',
};

/** HR and system administrators manage organization-wide attendance data. */
export const isAttendanceAdmin = (role: Role | undefined | null) => role === 'hr' || role === 'sysadmin';
export const isSysAdmin = (role: Role | undefined | null) => role === 'sysadmin';
export const isSupervisor = (role: Role | undefined | null) => role === 'supervisor';
export const canAccessAdminConsole = (role: Role | undefined | null) =>
  role === 'supervisor' || role === 'hr' || role === 'sysadmin';

/** Whether `viewer` may see records belonging to a member in `departmentId`. */
export function canViewDepartment(viewer: Pick<MemberDoc, 'role' | 'supervisedDepartmentIds'>, departmentId: string): boolean {
  if (isAttendanceAdmin(viewer.role)) return true;
  return viewer.role === 'supervisor' && viewer.supervisedDepartmentIds.includes(departmentId);
}

/**
 * Review permission for correction/fieldwork/overtime requests. Nobody may
 * review their own request, regardless of role.
 */
export function canReviewRequest(
  reviewer: Pick<MemberDoc, 'uid' | 'role' | 'supervisedDepartmentIds' | 'active'>,
  request: { memberId: string; departmentId: string },
  approvalMode: 'supervisor_or_hr' | 'hr_only',
): { ok: true } | { ok: false; reason: string } {
  if (!reviewer.active) return { ok: false, reason: 'Your account is inactive.' };
  if (reviewer.uid === request.memberId) return { ok: false, reason: 'You cannot review your own request.' };
  if (isAttendanceAdmin(reviewer.role)) return { ok: true };
  if (approvalMode === 'supervisor_or_hr' && reviewer.role === 'supervisor' && reviewer.supervisedDepartmentIds.includes(request.departmentId)) {
    return { ok: true };
  }
  return { ok: false, reason: 'This request is outside your review scope.' };
}
