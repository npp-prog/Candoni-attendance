import { Suspense } from 'react';
import { NavLink, Outlet } from 'react-router-dom';
import { canAccessAdminConsole, isAttendanceAdmin, isSysAdmin } from '../../shared/roles';
import { useSession } from '../context/AuthContext';
import { BrandHeader } from './Brand';
import { Alert, cx, PageLoader, useOnline } from './ui';

function OfflineBanner() {
  const online = useOnline();
  if (online) return null;
  return (
    <div className="no-print bg-amber-100 px-4 py-2 text-center text-sm font-medium text-amber-900" role="status">
      ⚠ You are offline. Attendance cannot be recorded without an internet connection.
    </div>
  );
}

const tabs = [
  { to: '/', label: 'Today', icon: '◉', end: true },
  { to: '/history', label: 'History', icon: '☰' },
  { to: '/requests', label: 'Requests', icon: '✎' },
  { to: '/profile', label: 'Profile', icon: '☺' },
];

export function EmployeeLayout() {
  const { member } = useSession();
  return (
    <div className="min-h-dvh pb-24">
      <OfflineBanner />
      <header className="no-print sticky top-0 z-30 border-b border-slate-200 bg-white/95 backdrop-blur">
        <div className="mx-auto flex max-w-xl items-center justify-between gap-2 px-4 py-2">
          <BrandHeader compact />
          {canAccessAdminConsole(member.role) && (
            <NavLink to="/admin" className="min-h-11 rounded-xl px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50">
              Admin console →
            </NavLink>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-xl px-4 py-4">
        <Suspense fallback={<PageLoader />}>
          <Outlet />
        </Suspense>
      </main>
      <nav className="no-print safe-bottom fixed inset-x-0 bottom-0 z-30 border-t border-slate-200 bg-white" aria-label="Main">
        <ul className="mx-auto grid max-w-xl grid-cols-4">
          {tabs.map((t) => (
            <li key={t.to}>
              <NavLink
                to={t.to}
                end={t.end}
                className={({ isActive }) => cx('flex min-h-14 flex-col items-center justify-center gap-0.5 text-xs font-semibold', isActive ? 'text-brand-700' : 'text-slate-600')}
              >
                {({ isActive }) => (
                  <>
                    <span aria-hidden className={cx('text-lg', isActive && 'scale-110')}>
                      {t.icon}
                    </span>
                    <span className={isActive ? 'underline underline-offset-4' : ''}>{t.label}</span>
                  </>
                )}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}

export function AdminLayout() {
  const { member } = useSession();
  const admin = isAttendanceAdmin(member.role);
  const links = [
    { to: '/admin', label: 'Dashboard', end: true, show: true },
    { to: '/admin/requests', label: 'Approvals', show: true },
    { to: '/admin/employees', label: 'Employees', show: true },
    { to: '/admin/reports', label: 'Reports', show: true },
    { to: '/admin/departments', label: 'Departments', show: admin },
    { to: '/admin/workplaces', label: 'Workplaces', show: admin },
    { to: '/admin/schedules', label: 'Schedules', show: admin },
    { to: '/admin/calendar', label: 'Holidays & leave', show: admin },
    { to: '/admin/audit', label: 'Audit & attempts', show: admin },
    { to: '/admin/settings', label: isSysAdmin(member.role) ? 'Settings' : 'Maintenance', show: admin },
  ].filter((l) => l.show);
  if (!canAccessAdminConsole(member.role)) {
    return (
      <div className="p-4">
        <Alert tone="danger" title="Not authorized">
          The admin console is available to supervisors and administrators only.
        </Alert>
      </div>
    );
  }
  return (
    <div className="min-h-dvh lg:flex">
      <aside className="no-print border-b border-slate-200 bg-white lg:sticky lg:top-0 lg:h-dvh lg:w-60 lg:shrink-0 lg:border-r lg:border-b-0">
        <div className="flex items-center justify-between gap-2 px-4 py-3">
          <BrandHeader compact />
          <NavLink to="/" className="min-h-11 rounded-xl px-3 py-2 text-sm font-semibold text-brand-700 hover:bg-brand-50 lg:hidden">
            My attendance
          </NavLink>
        </div>
        <nav aria-label="Admin" className="overflow-x-auto px-2 pb-2 lg:overflow-visible">
          <ul className="flex gap-1 lg:flex-col">
            {links.map((l) => (
              <li key={l.to}>
                <NavLink
                  to={l.to}
                  end={l.end}
                  className={({ isActive }) =>
                    cx('flex min-h-11 items-center whitespace-nowrap rounded-xl px-3 text-sm font-semibold', isActive ? 'bg-navy-900 text-white' : 'text-navy-800 hover:bg-navy-50')
                  }
                >
                  {l.label}
                </NavLink>
              </li>
            ))}
            <li className="hidden lg:block">
              <NavLink to="/" className="mt-4 flex min-h-11 items-center rounded-xl px-3 text-sm font-semibold text-brand-700 hover:bg-brand-50">
                ← My attendance
              </NavLink>
            </li>
          </ul>
        </nav>
      </aside>
      <div className="min-w-0 flex-1">
        <OfflineBanner />
        <main className="mx-auto max-w-6xl px-4 py-4">
          <Suspense fallback={<PageLoader />}>
            <Outlet />
          </Suspense>
        </main>
      </div>
    </div>
  );
}
