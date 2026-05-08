import { useState, useEffect } from 'react';
import { PanelLeftClose, PanelLeft, LogOut, User, ChevronDown, Briefcase, TrendingUp } from 'lucide-react';
import { STATUS_OPTIONS } from '../../lib/constants';
import type { Role } from '../../lib/constants';
import { useAdvisorContext } from '../../contexts/AdvisorContext';
import { useCustomerContext } from '../../contexts/CustomerContext';
import { setPresence } from '../../lib/matrixPresence';
import type { PresenceStatus } from '../../lib/matrixPresence';
import { getAdvisorPresence } from '../../lib/api';
import { toast } from '../ui';

interface TopbarProps {
  role: Role;
  collapsed: boolean;
  onToggle: () => void;
  onLogout: () => void;
}

const TYPE_LABELS = { PM: 'Portföy Yöneticisi', IA: 'Yatırım Danışmanı' } as const;
const ON_LEAVE_LABEL = 'İzinli';
const ON_LEAVE_TOOLTIP = 'İzinlisiniz; durumunuz değiştirilemez.';

export function Topbar({ role, collapsed, onToggle, onLogout }: TopbarProps) {
  const { advisorId, advisorName, advisorType } = useAdvisorContext();
  const { customerId, segment } = useCustomerContext();
  const [status, setStatus] = useState<PresenceStatus>('online');
  const [onLeave, setOnLeave] = useState(false);
  const [dropdownOpen, setDropdownOpen] = useState(false);
  const [statusLoading, setStatusLoading] = useState(false);
  const currentStatus = STATUS_OPTIONS.find((s) => s.value === status) || STATUS_OPTIONS[0];
  const presenceDisabled = onLeave || statusLoading;

  useEffect(() => {
    if (role !== 'advisor' || !advisorId) return;
    let cancelled = false;
    const refresh = () => {
      getAdvisorPresence(advisorId).then((res) => {
        if (cancelled) return;
        if (res.ok) {
          setStatus(res.presence as PresenceStatus);
          setOnLeave(res.onLeave);
        }
      });
    };
    refresh();
    // Periodic refresh so the badge flips when the timer-driven state change
    // happens server-side (auto-leave-start / auto-leave-end transitions).
    const interval = window.setInterval(refresh, 30_000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [role, advisorId]);

  const handleStatusChange = async (newStatus: PresenceStatus) => {
    if (!advisorId || statusLoading) return;
    if (onLeave) {
      toast(ON_LEAVE_TOOLTIP, 'error');
      setDropdownOpen(false);
      return;
    }
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
            className={`status-selector${onLeave ? ' status-selector--on-leave' : ''}`}
            title={onLeave ? ON_LEAVE_TOOLTIP : undefined}
            style={{
              opacity: statusLoading ? 0.7 : 1,
              pointerEvents: presenceDisabled ? 'none' : 'auto',
              cursor: presenceDisabled ? 'not-allowed' : 'pointer',
            }}
            onClick={() => {
              if (presenceDisabled) return;
              setDropdownOpen(!dropdownOpen);
            }}
          >
            <span
              className="status-dot"
              style={{ background: onLeave ? '#9ca3af' : currentStatus.color }}
            />
            <span className="status-label">{onLeave ? ON_LEAVE_LABEL : currentStatus.label}</span>
            <ChevronDown size={14} />
            {dropdownOpen && !onLeave && (
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
