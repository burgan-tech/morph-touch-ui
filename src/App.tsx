import { BrowserRouter, Routes, Route, Navigate } from 'react-router-dom';
import { useRole } from './hooks/useRole';
import type { Role } from './lib/constants';
import { AdvisorProvider, useAdvisorContext } from './contexts/AdvisorContext';
import { CustomerProvider, useCustomerContext } from './contexts/CustomerContext';
import { AppLayout } from './components/layout/AppLayout';
import { ToastContainer } from './components/ui';
import { RoleSelect } from './pages/RoleSelect';

import { Dashboard as AdvisorDashboard, VideoCalls, ChatManagement, Appointments as AdvisorAppointments, Absence, Help as AdvisorHelp } from './pages/advisor';
import { Dashboard as AdminDashboard, StaffManagement, Appointments as AdminAppointments, Communications, AbsenceManagement, Help as AdminHelp } from './pages/admin';
import { Dashboard as AuditDashboard, VideoRecords, ChatRecords } from './pages/audit';
import { Dashboard as CustomerDashboard, Chat as CustomerChat } from './pages/customer';

function AppInner() {
  const { role, setRole, logout } = useRole();
  const { advisorId, setAdvisor, clearAdvisor } = useAdvisorContext();
  const { customerId, setCustomer, clearCustomer } = useCustomerContext();

  const handleLogout = () => {
    clearAdvisor();
    clearCustomer();
    logout();
    window.history.replaceState(null, '', '/');
  };

  const handleRoleSelect = (selectedRole: Role) => {
    window.history.replaceState(null, '', `/${selectedRole}`);
    setRole(selectedRole);
  };

  if (!role || (role === 'advisor' && !advisorId) || (role === 'customer' && !customerId)) {
    return (
      <>
        <RoleSelect
          onSelect={handleRoleSelect}
          onAdvisorSelect={(id, type, name) => setAdvisor(id, type, name)}
          onCustomerSelect={(id, segment) => setCustomer(id, segment)}
        />
        <ToastContainer />
      </>
    );
  }

  return (
    <BrowserRouter>
      <Routes>
        <Route element={<AppLayout role={role} onLogout={handleLogout} />}>
          {/* Advisor routes */}
          <Route path="/advisor" element={<AdvisorDashboard />} />
          <Route path="/advisor/video-calls" element={<VideoCalls />} />
          <Route path="/advisor/chat" element={<ChatManagement />} />
          <Route path="/advisor/appointments" element={<AdvisorAppointments />} />
          <Route path="/advisor/absence" element={<Absence />} />
          <Route path="/advisor/help" element={<AdvisorHelp />} />

          {/* Admin routes */}
          <Route path="/admin" element={<AdminDashboard />} />
          <Route path="/admin/staff" element={<StaffManagement />} />
          <Route path="/admin/appointments" element={<AdminAppointments />} />
          <Route path="/admin/communications" element={<Communications />} />
          <Route path="/admin/settings" element={<AbsenceManagement />} />
          <Route path="/admin/help" element={<AdminHelp />} />

          {/* Audit routes */}
          <Route path="/audit" element={<AuditDashboard />} />
          <Route path="/audit/video-records" element={<VideoRecords />} />
          <Route path="/audit/chat-records" element={<ChatRecords />} />

          {/* Customer routes */}
          <Route path="/customer" element={<CustomerDashboard />} />
          <Route path="/customer/chat" element={<CustomerChat />} />

          {/* Default redirect */}
          <Route path="*" element={<Navigate to={`/${role}`} replace />} />
        </Route>
      </Routes>
      <ToastContainer />
    </BrowserRouter>
  );
}

export default function App() {
  return (
    <AdvisorProvider>
      <CustomerProvider>
        <AppInner />
      </CustomerProvider>
    </AdvisorProvider>
  );
}
