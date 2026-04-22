import { useState, useEffect } from 'react';
import { PanelLeftClose, PanelLeft, LogOut, User, ChevronDown, Briefcase, TrendingUp } from 'lucide-react';
import { STATUS_OPTIONS } from '../../lib/constants';
import type { Role } from '../../lib/constants';
import { useAdvisorContext } from '../../contexts/AdvisorContext';
import { useCustomerContext } from '../../contexts/CustomerContext';
import { getPresence, setPresence } from '../../lib/matrixPresence';
import type { PresenceStatus } from '../../lib/matrixPresence';
import { toast } from '../../components/ui';

interface TopbarProps {
  role: Role;
  collapsed: boolean;
  onToggle: () => void;
  onLogout: () => void;
}

const TYPE_LABELS = { PM: 'Portföy Yöneticisi', IA: 'Yatırım Danışmanı' } as const;

export function Topbar({ role, collapsed, onToggle, onLogout }: TopbarProps) {
  const { advisorId, advisorName, advisorType } = useAdvisorContext();
  const { customerId, segment } = useCustomerContext();
  const [status, setStatus] = useState<PresenceStatus>('online');
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const currentStatus = STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];

  useEffect(() => {
    if (role !== 'advisor' || !advisorId) return;
    getPresence(advisorId).then((res) => {
      if (res.ok && res.status) setStatus(res.status);
    });
  }, [role, advisorId]);

  const handleStatusChange = async (newStatus: PresenceStatus) => {
    if (!advisorId || statusLoading) return;
    setStatusLoading(true);
    setDropdownOpen(false);
    const res = await setPresence(advisorId, newStatus);
    setStatusLoading(false);
    if (res.ok) {
      setStatus(newStatus);
    } else {
      toast(res.error ?? 'Durum güncellenemedi', 'error');
    }
  };

  const TypeIcon = advisorType === 'PM' ? Briefcase : TrendingUp;

  return (
    <header className="topbar">
      <div className="topbar-left">
        <button className="btn-icon" onClick={onToggle} title={collapsed ? 'Menüyü Aç' : 'Menüyü Kapat'}>
          {collapsed ? <PanelLeft size={20} /> : <PanelLeftClose size={20} />}
        </button>
      </div>
      <div className="topbar-right">
        {role === 'advisor' && advisorId && (
          <div
            className="status-selector"
            style={{ opacity: statusLoading ? 0.7 : 1, pointerEvents: statusLoading ? 'none' : 'auto' }}
            onClick={() => setDropdownOpen(!dropdownOpen)}
          >
            <span className="status-dot" style={{ background: currentStatus.color }} />
            <span className="status-label">{currentStatus.label}</span>
            <ChevronDown size={14} />
            {dropdownOpen && (
              <div className="status-dropdown">
                {STATUS_OPTIONS.map((opt) => (
                  <button
                    key={opt.value}
                    className={`status-option ${opt.value === status ? 'active' : ''}`}
                    onClick={(e) => { e.stopPropagation(); handleStatusChange(opt.value as PresenceStatus); }}
                  >
                    <span className="status-dot" style={{ background: opt.color }} />
                    {opt.label}
                  </button>
                ))}
              </div>
            )}
          </div>
        )}
        <div className="topbar-user">
          {role === 'advisor' && advisorName ? (
            <>
              <TypeIcon size={18} />
              <span className="topbar-advisor-name">{advisorName}</span>
              {advisorType && <span className="topbar-advisor-type">{TYPE_LABELS[advisorType]}</span>}
            </>
          ) : role === 'customer' && customerId ? (
            <>
              <User size={18} />
              <span className="topbar-advisor-name">{customerId}</span>
              {segment && <span className="topbar-advisor-type">{segment}</span>}
            </>
          ) : (
            <>
              <User size={18} />
              <span>{role === 'admin' ? 'Admin' : role === 'audit' ? 'Audit' : 'Kullanıcı'}</span>
            </>
          )}
        </div>
        <button className="btn-icon" onClick={onLogout} title="Çıkış">
          <LogOut size={18} />
        </button>
      </div>
    </header>
  );
}
