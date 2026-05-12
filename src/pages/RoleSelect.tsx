import { useState } from 'react';
import { Shield, UserCheck, Briefcase, TrendingUp, User } from 'lucide-react';
import type { Role } from '../lib/constants';
import type { AdvisorType } from '../contexts/AdvisorContext';
import type { CustomerSegment } from '../contexts/CustomerContext';

const CUSTOMERS: {
  customerId: string;
  segment: CustomerSegment;
  label: string;
  // Optional explicit advisor assignment. Falls back to user{num} → pm{num}/ia{num}
  // when omitted (see customer Dashboard).
  pmKey?: string;
  iaKey?: string;
}[] = [
  { customerId: 'user001', segment: 'Private', label: 'Müşteri 1' },
  { customerId: 'user002', segment: 'Private Plus', label: 'Müşteri 2' },
  { customerId: 'user003', segment: 'Private Plus', label: 'Müşteri 3' },
  { customerId: 'user004', segment: 'Private Plus', label: 'Müşteri 4', pmKey: 'pm003', iaKey: 'ia002' },
];

interface RoleSelectProps {
  onSelect: (role: Role) => void;
  onAdvisorSelect: (id: string, type: AdvisorType, name: string) => void;
  onCustomerSelect?: (
    customerId: string,
    segment: CustomerSegment,
    pmKey?: string,
    iaKey?: string,
  ) => void;
}

const roles: { role: Role; label: string; desc: string; icon: React.ElementType }[] = [
  { role: 'customer', label: 'Müşteri', desc: 'Finansal rehberlerinizle iletişim', icon: User },
  { role: 'advisor', label: 'Yetkili Kullanıcı', desc: 'Portföy Yöneticisi / Yatırım Danışmanı', icon: UserCheck },
  { role: 'admin', label: 'Admin', desc: 'Yönetim paneli ve personel yönetimi', icon: Shield },
];

const ADVISOR_PM_FALLBACK = 'pm001';
const ADVISOR_IA_FALLBACK = 'ia001';

function advisorManualKeyInvalid(raw: string): boolean {
  const t = raw.trim();
  if (!t) return false;
  return /^\d/.test(t);
}

export function RoleSelect({ onSelect, onAdvisorSelect, onCustomerSelect }: RoleSelectProps) {
  const [step, setStep] = useState<'role' | 'advisor' | 'customer'>('role');
  const [advisorPmInput, setAdvisorPmInput] = useState('');
  const [advisorIaInput, setAdvisorIaInput] = useState('');
  const [customerIds, setCustomerIds] = useState<string[]>(() => CUSTOMERS.map((c) => c.customerId));

  const handleRoleClick = (role: Role) => {
    if (role === 'advisor') {
      setStep('advisor');
    } else if (role === 'customer') {
      setStep('customer');
    } else {
      onSelect(role);
    }
  };

  const handleCustomerClick = (c: (typeof CUSTOMERS)[number], customerId: string) => {
    const trimmed = customerId.trim() || c.customerId;
    onCustomerSelect?.(trimmed, c.segment, c.pmKey, c.iaKey);
    onSelect('customer');
  };

  const handleAdvisorManualLogin = (type: AdvisorType, raw: string, fallbackKey: string) => {
    if (advisorManualKeyInvalid(raw)) return;
    const key = raw.trim() || fallbackKey;
    onAdvisorSelect(key, type, key);
    onSelect('advisor');
  };

  if (step === 'customer') {
    return (
      <div className="role-select-page">
        <div className="role-select-container">
          <h1 className="role-select-title">Wealth App</h1>
          <p className="role-select-subtitle">Müşteri hesabınızı seçin</p>
          <div className="advisor-list">
            {CUSTOMERS.map((c, idx) => (
              <div key={c.customerId} className="advisor-card">
                <div className="advisor-card-icon">
                  <User size={24} />
                </div>
                <div className="advisor-card-info">
                  <span className="advisor-card-name">{c.label}</span>
                  <span className="advisor-card-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                    <input
                      type="text"
                      className="role-select-input"
                      value={customerIds[idx]}
                      placeholder={c.customerId}
                      onChange={(e) =>
                        setCustomerIds((prev) => {
                          const next = [...prev];
                          next[idx] = e.target.value;
                          return next;
                        })
                      }
                      aria-label={`${c.label} müşteri kimliği`}
                    />
                    <span>&middot; {c.segment}</span>
                  </span>
                </div>
                <button
                  type="button"
                  className="btn btn-primary"
                  style={{ flexShrink: 0 }}
                  onClick={() => handleCustomerClick(c, customerIds[idx])}
                >
                  Giriş
                </button>
              </div>
            ))}
          </div>
          <button className="btn btn-secondary" style={{ marginTop: 20 }} onClick={() => setStep('role')}>
            Geri
          </button>
        </div>
      </div>
    );
  }

  if (step === 'advisor') {
    return (
      <div className="role-select-page">
        <div className="role-select-container">
          <h1 className="role-select-title">Wealth App</h1>
          <p className="role-select-subtitle">Danışman hesabınızı seçin</p>
          <div className="advisor-list">
            <div className="advisor-card">
              <div className="advisor-card-icon">
                <Briefcase size={24} />
              </div>
              <div className="advisor-card-info">
                <span className="advisor-card-name">PM</span>
                <span className="advisor-card-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="role-select-input"
                    value={advisorPmInput}
                    placeholder={ADVISOR_PM_FALLBACK}
                    onChange={(e) => setAdvisorPmInput(e.target.value)}
                    aria-label="Portföy yöneticisi instance anahtarı"
                    aria-invalid={advisorManualKeyInvalid(advisorPmInput)}
                  />
                  <span>&middot; Portföy Yöneticisi</span>
                </span>
                {advisorManualKeyInvalid(advisorPmInput) && (
                  <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginTop: 8, marginBottom: 0 }}>
                    Anahtar rakamla başlayamaz.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flexShrink: 0 }}
                disabled={advisorManualKeyInvalid(advisorPmInput)}
                onClick={() => handleAdvisorManualLogin('PM', advisorPmInput, ADVISOR_PM_FALLBACK)}
              >
                Giriş
              </button>
            </div>
            <div className="advisor-card">
              <div className="advisor-card-icon">
                <TrendingUp size={24} />
              </div>
              <div className="advisor-card-info">
                <span className="advisor-card-name">IA</span>
                <span className="advisor-card-meta" style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  <input
                    type="text"
                    className="role-select-input"
                    value={advisorIaInput}
                    placeholder={ADVISOR_IA_FALLBACK}
                    onChange={(e) => setAdvisorIaInput(e.target.value)}
                    aria-label="Yatırım danışmanı instance anahtarı"
                    aria-invalid={advisorManualKeyInvalid(advisorIaInput)}
                  />
                  <span>&middot; Yatırım Danışmanı</span>
                </span>
                {advisorManualKeyInvalid(advisorIaInput) && (
                  <p style={{ color: 'var(--color-danger)', fontSize: '0.85rem', marginTop: 8, marginBottom: 0 }}>
                    Anahtar rakamla başlayamaz.
                  </p>
                )}
              </div>
              <button
                type="button"
                className="btn btn-primary"
                style={{ flexShrink: 0 }}
                disabled={advisorManualKeyInvalid(advisorIaInput)}
                onClick={() => handleAdvisorManualLogin('IA', advisorIaInput, ADVISOR_IA_FALLBACK)}
              >
                Giriş
              </button>
            </div>
          </div>
          <button className="btn btn-secondary" style={{ marginTop: 20 }} onClick={() => setStep('role')}>
            Geri
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="role-select-page">
      <div className="role-select-container">
        <h1 className="role-select-title">Wealth App</h1>
        <p className="role-select-subtitle">Giriş yapmak için rolünüzü seçin</p>
        <div className="role-cards">
          {roles.map(({ role, label, desc, icon: Icon }) => (
            <button key={role} className="role-card" onClick={() => handleRoleClick(role)}>
              <Icon size={32} strokeWidth={1.5} />
              <h3>{label}</h3>
              <p>{desc}</p>
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}
