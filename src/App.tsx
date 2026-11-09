import { lazy, Suspense, useEffect } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { canAccessAdminConsole } from '../shared/roles';
import { AdminLayout, EmployeeLayout } from './components/Layouts';
import { PageLoader } from './components/ui';
import { AuthProvider, useAuth } from './context/AuthContext';
import { firebaseConfigured } from './firebase';
import { AccountProblem, ConfigMissing, InactiveAccount, PrivacyGate } from './pages/Gates';
import Login from './pages/Login';
import Home from './pages/employee/Home';

// Route modules are code-split, then preloaded in the background after sign-in
// so sidebar navigation does not wait on a network download.
const employeePages = {
  History: () => import('./pages/employee/History'),
  Requests: () => import('./pages/employee/Requests'),
  Profile: () => import('./pages/employee/Profile'),
};
const adminPages = {
  AdminDashboard: () => import('./pages/admin/Dashboard'),
  AdminRequests: () => import('./pages/admin/Requests'),
  Employees: () => import('./pages/admin/Employees'),
  EmployeeDetail: () => import('./pages/admin/EmployeeDetail'),
  Departments: () => import('./pages/admin/Departments'),
  Workplaces: () => import('./pages/admin/Workplaces'),
  Schedules: () => import('./pages/admin/Schedules'),
  Calendar: () => import('./pages/admin/Calendar'),
  Reports: () => import('./pages/admin/Reports'),
  Audit: () => import('./pages/admin/Audit'),
  Settings: () => import('./pages/admin/Settings'),
};
const History = lazy(employeePages.History);
const Requests = lazy(employeePages.Requests);
const Profile = lazy(employeePages.Profile);
const AdminDashboard = lazy(adminPages.AdminDashboard);
const AdminRequests = lazy(adminPages.AdminRequests);
const Employees = lazy(adminPages.Employees);
const EmployeeDetail = lazy(adminPages.EmployeeDetail);
const Departments = lazy(adminPages.Departments);
const Workplaces = lazy(adminPages.Workplaces);
const Schedules = lazy(adminPages.Schedules);
const Calendar = lazy(adminPages.Calendar);
const Reports = lazy(adminPages.Reports);
const Audit = lazy(adminPages.Audit);
const Settings = lazy(adminPages.Settings);

function usePreloadPages(includeAdmin: boolean) {
  useEffect(() => {
    const loaders = [...Object.values(employeePages), ...(includeAdmin ? Object.values(adminPages) : [])];
    const run = () => loaders.forEach((load) => load().catch(() => undefined));
    const w = window as Window & { requestIdleCallback?: (cb: () => void) => number };
    if (w.requestIdleCallback) w.requestIdleCallback(run);
    else setTimeout(run, 1500);
  }, [includeAdmin]);
}

function Gate() {
  const { loading, user, member, org, error } = useAuth();
  usePreloadPages(!!member?.active && canAccessAdminConsole(member.role));
  if (!firebaseConfigured) return <ConfigMissing />;
  if (loading) return <PageLoader label="Loading your account…" />;
  if (!user) return <Login />;
  if (member && !member.active) return <InactiveAccount />;
  if (error || !member || !org) return <AccountProblem message={error ?? 'Unable to load your account.'} />;
  if ((member.privacyAcceptedVersion ?? 0) < org.settings.privacyNoticeVersion) return <PrivacyGate />;
  return (
    <Suspense fallback={<PageLoader />}>
      <Routes>
        <Route element={<EmployeeLayout />}>
          <Route index element={<Home />} />
          <Route path="history" element={<History />} />
          <Route path="requests" element={<Requests />} />
          <Route path="profile" element={<Profile />} />
        </Route>
        <Route path="admin" element={<AdminLayout />}>
          <Route index element={<AdminDashboard />} />
          <Route path="requests" element={<AdminRequests />} />
          <Route path="employees" element={<Employees />} />
          <Route path="employees/:uid" element={<EmployeeDetail />} />
          <Route path="departments" element={<Departments />} />
          <Route path="workplaces" element={<Workplaces />} />
          <Route path="schedules" element={<Schedules />} />
          <Route path="calendar" element={<Calendar />} />
          <Route path="reports" element={<Reports />} />
          <Route path="audit" element={<Audit />} />
          <Route path="settings" element={<Settings />} />
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </Suspense>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Gate />
      </AuthProvider>
    </BrowserRouter>
  );
}
