import { useState, useEffect } from 'react';
import { Shield, UserCheck, RefreshCw, Briefcase, TrendingUp, User } from 'lucide-react';
import type { Role } from '../lib/constants';
import type { AdvisorType } from '../contexts/AdvisorContext';
import type { CustomerSegment } from '../contexts/CustomerContext';
import { listInstances } from '../lib/api';

interface AdvisorItem {
  key: string;
  id?: string;
  type: AdvisorType;
  name: string;
  state: string;
}

const CUSTOMERS: { customerId: string; segment: CustomerSegment; label: string }[] = [
  { customerId: 'user001', segment: 'Private', label: 'Müşteri 1' },
  { customerId: 'user002', segment: 'Private Plus', label: 'Müşteri 2' },
  { customerId: 'user003', segment: 'Private Plus', label: 'Müşteri 3' },
];

interface RoleSelectProps {
  onSelect: (role: Role) => void;
  onAdvisorSelect: (id: string, type: AdvisorType, name: string) => void;
  onCustomerSelect?: (customerId: string, segment: CustomerSegment) => void;
}

const roles: { role: Role; label: string; desc: string; icon: React.ElementType }[] = [
  { role: 'customer', label: 'Müşteri', desc: 'Finansal rehberlerinizle iletişim', icon: User },
  { role: 'advisor', label: 'Yetkili Kullanıcı', desc: 'Portföy Yöneticisi / Yatırım Danışmanı', icon: UserCheck },
  { role: 'admin', label: 'Admin', desc: 'Yönetim paneli ve personel yönetimi', icon: Shield },
];

interface VnextInstance {
  key: string;
  id?: string;
  attributes?: Record<string, unknown>;
  metadata?: { currentState?: string };
}

function extractItems(res: { ok: boolean; data?: unknown }): VnextInstance[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;
  const items = (d?.items ?? (d?.data as Record<string, unknown>)?.items) as VnextInstance[] | undefined;
  return Array.isArray(items) ? items : [];
}

function buildName(inst: VnextInstance): string {
  const a = inst.attributes ?? {};
  const first = (a.firstName ?? a.name ?? '') as string;
  const last = (a.lastName ?? a.surname ?? '') as string;
  if (first || last) return `${first} ${last}`.trim();
  return inst.key;
}

export function RoleSelect({ onSelect, onAdvisorSelect, onCustomerSelect }: RoleSelectProps) {
  const [step, setStep] = useState<'role' | 'advisor' | 'customer'>('role');
  const [advisors, setAdvisors] = useState<AdvisorItem[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchAdvisors = async () => {
    setLoading(true);
    setError(null);
    try {
      const [pmRes, iaRes] = await Promise.all([
        listInstances('portfolio-manager', { pageSize: 100 }),
        listInstances('investment-advisor', { pageSize: 100 }),
      ]);

      const pmItems = extractItems(pmRes).map((inst): AdvisorItem => ({
        key: inst.key,
        id: inst.id,
        type: 'PM',
        name: buildName(inst),
        state: inst.metadata?.currentState ?? 'unknown',
      }));

      const iaItems = extractItems(iaRes).map((inst): AdvisorItem => ({
        key: inst.key,
        id: inst.id,
        type: 'IA',
        name: buildName(inst),
        state: inst.metadata?.currentState ?? 'unknown',
      }));

      const all = [...pmItems, ...iaItems].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
      setAdvisors(all);
      if (all.length === 0) setError('Sistemde kayıtlı danışman bulunamadı');
    } catch {
      setError('Danışman listesi yüklenemedi');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (step === 'advisor') fetchAdvisors();
  }, [step]);

  const handleRoleClick = (role: Role) => {
    if (role === 'advisor') {
      setStep('advisor');
    } else if (role === 'customer') {
      setStep('customer');
    } else {
      onSelect(role);
    }
  };

  const handleCustomerClick = (c: (typeof CUSTOMERS)[number]) => {
    onCustomerSelect?.(c.customerId, c.segment);
    onSelect('customer');
  };

  const handleAdvisorClick = (adv: AdvisorItem) => {
    onAdvisorSelect(adv.key, adv.type, adv.name);
    onSelect('advisor');
  };

  if (step === 'customer') {
    return (
      <div className="role-select-page">
        <div className="role-select-container">
          <h1 className="role-select-title">Wealth App</h1>
          <p className="role-select-subtitle">Müşteri hesabınızı seçin</p>
          <div className="advisor-list">
            {CUSTOMERS.map((c) => (
              <button key={c.customerId} className="advisor-card" onClick={() => handleCustomerClick(c)}>
                <div className="advisor-card-icon">
                  <User size={24} />
                </div>
                <div className="advisor-card-info">
                  <span className="advisor-card-name">{c.label}</span>
                  <span className="advisor-card-meta">{c.customerId} &middot; {c.segment}</span>
                </div>
              </button>
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

          {loading && (
            <div className="empty-state" style={{ padding: 32 }}>
              <RefreshCw size={32} className="animate-spin" />
              <p>Danışmanlar yükleniyor...</p>
            </div>
          )}

          {error && !loading && (
            <div className="empty-state" style={{ padding: 32 }}>
              <p style={{ color: 'var(--color-danger)' }}>{error}</p>
              <button className="btn btn-secondary" onClick={fetchAdvisors}>Tekrar Dene</button>
            </div>
          )}

          {!loading && !error && advisors.length > 0 && (
            <div className="advisor-list">
              {advisors.map((adv) => {
                const Icon = adv.type === 'PM' ? Briefcase : TrendingUp;
                const typeLabel = adv.type === 'PM' ? 'Portföy Yöneticisi' : 'Yatırım Danışmanı';
                return (
                  <button key={adv.key} className="advisor-card" onClick={() => handleAdvisorClick(adv)}>
                    <div className="advisor-card-icon">
                      <Icon size={24} />
                    </div>
                    <div className="advisor-card-info">
                      <span className="advisor-card-name">{adv.name}</span>
                      <span className="advisor-card-meta">{typeLabel} &middot; {adv.key}</span>
                    </div>
                    <span className={`advisor-card-state advisor-card-state-${adv.state}`}>{adv.state}</span>
                  </button>
                );
              })}
            </div>
          )}

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
