import { lazy, Suspense } from 'react';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import { AdminLayout, EmployeeLayout } from './components/Layouts';
import { PageLoader } from './components/ui';
import { AuthProvider, useAuth } from './context/AuthContext';
import { firebaseConfigured } from './firebase';
import { AccountProblem, ConfigMissing, InactiveAccount, PrivacyGate } from './pages/Gates';
import Login from './pages/Login';
import Home from './pages/employee/Home';

const History = lazy(() => import('./pages/employee/History'));
const Requests = lazy(() => import('./pages/employee/Requests'));
const Profile = lazy(() => import('./pages/employee/Profile'));
const AdminDashboard = lazy(() => import('./pages/admin/Dashboard'));
const AdminRequests = lazy(() => import('./pages/admin/Requests'));
const Employees = lazy(() => import('./pages/admin/Employees'));
const EmployeeDetail = lazy(() => import('./pages/admin/EmployeeDetail'));
const Departments = lazy(() => import('./pages/admin/Departments'));
const Workplaces = lazy(() => import('./pages/admin/Workplaces'));
const Schedules = lazy(() => import('./pages/admin/Schedules'));
const Calendar = lazy(() => import('./pages/admin/Calendar'));
const Reports = lazy(() => import('./pages/admin/Reports'));
const Audit = lazy(() => import('./pages/admin/Audit'));
const Settings = lazy(() => import('./pages/admin/Settings'));

function Gate() {
  const { loading, user, member, org, error } = useAuth();
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
