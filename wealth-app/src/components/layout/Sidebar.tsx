import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard, Video, MessageSquare, CalendarDays,
  CalendarOff, HelpCircle, Users, Monitor, Settings
} from 'lucide-react';
import type { Role } from '../../lib/constants';
import { ADVISOR_MENU, ADMIN_MENU, AUDIT_MENU, CUSTOMER_MENU, ROLE_LABELS } from '../../lib/constants';

const ICON_MAP: Record<string, React.ElementType> = {
  LayoutDashboard, Video, MessageSquare, CalendarDays,
  CalendarOff, HelpCircle, Users, Monitor, Settings,
};

function menuForRole(role: Role) {
  if (role === 'admin') return ADMIN_MENU;
  if (role === 'audit') return AUDIT_MENU;
  if (role === 'customer') return CUSTOMER_MENU;
  return ADVISOR_MENU;
}

interface SidebarProps {
  role: Role;
  collapsed: boolean;
}

export function Sidebar({ role, collapsed }: SidebarProps) {
  const menu = menuForRole(role);
  const basePath = `/${role}`;

  return (
    <aside className={`sidebar ${collapsed ? 'sidebar-collapsed' : ''}`}>
      <div className="sidebar-brand">
        {!collapsed && <span className="brand-text">Wealth App</span>}
        {collapsed && <span className="brand-text">W</span>}
      </div>
      <div className="sidebar-role">{!collapsed && ROLE_LABELS[role]}</div>
      <nav className="sidebar-nav">
        {menu.map((item) => {
          const Icon = ICON_MAP[item.icon] || LayoutDashboard;
          const to = item.key === 'dashboard' ? basePath : `${basePath}/${item.key}`;
          return (
            <NavLink
              key={item.key}
              to={to}
              end={item.key === 'dashboard'}
              className={({ isActive }) => `nav-item ${isActive ? 'nav-item-active' : ''}`}
              title={item.label}
            >
              <Icon size={20} />
              {!collapsed && <span>{item.label}</span>}
            </NavLink>
          );
        })}
      </nav>
    </aside>
  );
}
