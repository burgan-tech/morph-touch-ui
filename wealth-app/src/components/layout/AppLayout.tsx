import { useState } from 'react';
import { Outlet } from 'react-router-dom';
import { Sidebar } from './Sidebar';
import { Topbar } from './Topbar';
import type { Role } from '../../lib/constants';

interface AppLayoutProps {
  role: Role;
  onLogout: () => void;
}

export function AppLayout({ role, onLogout }: AppLayoutProps) {
  const [collapsed, setCollapsed] = useState(false);

  return (
    <div className={`app-layout ${collapsed ? 'sidebar-is-collapsed' : ''}`}>
      <Sidebar role={role} collapsed={collapsed} />
      <div className="app-main">
        <Topbar role={role} collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)} onLogout={onLogout} />
        <main className="app-content">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
