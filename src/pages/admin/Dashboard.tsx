import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  LayoutDashboard,
  CalendarDays,
  MessageSquare,
  CalendarOff,
  AlertTriangle,
  RefreshCw,
  Briefcase,
  TrendingUp,
} from 'lucide-react';
import {
  getReservations,
  getAbsenceEntries,
  listInstances,
} from '../../lib/api';
import { formatTime, formatDateTime, formatDate, cn } from '../../lib/utils';
import { STATE_LABELS } from '../../lib/constants';
import { Badge, EmptyState, toast } from '../../components/ui';

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  getChatRooms?: { items?: T[] };
  getAbsenceEntry?: { items?: T[] };
  [key: string]: unknown;
}

function extractReservations<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function extractAbsenceItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;
  const inner = d?.data as Record<string, unknown> | undefined;
  const items = (d?.items ?? (d?.getAbsenceEntry as Record<string, unknown>)?.items ?? inner?.items) as T[] | undefined;
  return Array.isArray(items) ? items : [];
}

function extractListItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function userName(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function advisorName(inst: VnextInstance): string {
  const adv = inst.attributes?.advisor ?? inst.attributes?.advisorId;
  return userName(adv);
}

function staffName(inst: VnextInstance): string {
  const a = inst.attributes ?? {};
  const first = (a.firstName as string) ?? '';
  const last = (a.lastName as string) ?? '';
  if (first || last) return `${first} ${last}`.trim();
  return (a.advisorId as string) ?? inst.key ?? '—';
}

function advisorRefToKey(ref: unknown): string {
  if (typeof ref === 'string') {
    const parts = ref.split('.');
    return parts[parts.length - 1] ?? ref;
  }
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '';
}

function advisorDisplayName(advisorRef: unknown, allStaff: VnextInstance[]): string {
  const key = advisorRefToKey(advisorRef);
  if (!key) return '—';
  const staff = allStaff.find((s) => (s.attributes?.advisorId ?? s.key) === key || s.key === key);
  if (staff) return staffName(staff);
  return typeof advisorRef === 'string' ? advisorRef : key;
}

function isActiveStaff(p: VnextInstance): boolean {
  const status = (p.attributes?.status ?? p.metadata?.currentState) as string;
  return status === 'online' || status === 'active' || status === 'busy' || status === 'away';
}

export function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<VnextInstance[]>([]);
  const [chatRooms, setChatRooms] = useState<VnextInstance[]>([]);
  const [absenceEntries, setAbsenceEntries] = useState<VnextInstance[]>([]);
  const [personalLeaveEntries, setPersonalLeaveEntries] = useState<VnextInstance[]>([]);
  const [portfolioManagers, setPortfolioManagers] = useState<VnextInstance[]>([]);
  const [investmentAdvisors, setInvestmentAdvisors] = useState<VnextInstance[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [rezRes, personalLeaveRes, pmRes, iaRes, chatListRes] = await Promise.all([
        getReservations({}, { touchUser: 'admin', userType: 'admin' }),
        getAbsenceEntries({ absenceType: 'personal-leave', pageSize: '200' }),
        listInstances('portfolio-manager', { pageSize: 100 }),
        listInstances('investment-advisor', { pageSize: 100 }),
        listInstances('chat-room', { pageSize: 100 }),
      ]);

      const rezItems = extractReservations<VnextInstance>(rezRes);
      const chatItems = extractListItems<VnextInstance>(chatListRes);
      const personalLeaveItems = extractAbsenceItems<VnextInstance>(personalLeaveRes);
      const pmItems = extractListItems<VnextInstance>(pmRes);
      const iaItems = extractListItems<VnextInstance>(iaRes);

      setReservations(rezItems);
      setChatRooms(chatItems);
      setAbsenceEntries(personalLeaveItems);
      setPersonalLeaveEntries(personalLeaveItems);
      setPortfolioManagers(pmItems);
      setInvestmentAdvisors(iaItems);

      if (!rezRes.ok || !personalLeaveRes.ok || !chatListRes.ok) {
        const err =
          (rezRes.data as Record<string, unknown>)?.error ??
          (personalLeaveRes.data as Record<string, unknown>)?.error ??
          (chatListRes.data as Record<string, unknown>)?.error;
        toast(String(err ?? 'Veri yüklenirken hata oluştu'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const today = new Date().toISOString().slice(0, 10);
  const [appointmentFilterStart, setAppointmentFilterStart] = useState(today);
  const [appointmentFilterEnd, setAppointmentFilterEnd] = useState(today);
  const [appointmentFilterAdvisor, setAppointmentFilterAdvisor] = useState('');
  const [appointmentFilterCustomer, setAppointmentFilterCustomer] = useState('');
  const [appointmentFilterStatus, setAppointmentFilterStatus] = useState('');
  const [leaveFilterStart, setLeaveFilterStart] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1).toISOString().slice(0, 10);
  });
  const [leaveFilterEnd, setLeaveFilterEnd] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth() + 1, 0).toISOString().slice(0, 10);
  });
  const [leaveFilterAdvisor, setLeaveFilterAdvisor] = useState('');

  const filteredReservations = useMemo(() => {
    return reservations
      .filter((r) => {
        const start = (r.attributes?.startDateTime as string)?.slice(0, 10);
        if (!start) return false;
        if (start < appointmentFilterStart || start > appointmentFilterEnd) return false;
        const adv = advisorName(r);
        if (appointmentFilterAdvisor && adv !== appointmentFilterAdvisor) return false;
        const cust = userName(r.attributes?.user);
        if (appointmentFilterCustomer && cust !== appointmentFilterCustomer) return false;
        const st = r.metadata?.currentState ?? '';
        if (appointmentFilterStatus && st !== appointmentFilterStatus) return false;
        return true;
      })
      .sort((a, b) =>
        String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''))
      );
  }, [reservations, appointmentFilterStart, appointmentFilterEnd, appointmentFilterAdvisor, appointmentFilterCustomer, appointmentFilterStatus]);

  const dateFilteredReservations = useMemo(() => {
    return reservations.filter((r) => {
      const start = (r.attributes?.startDateTime as string)?.slice(0, 10);
      if (!start) return false;
      return start >= appointmentFilterStart && start <= appointmentFilterEnd;
    });
  }, [reservations, appointmentFilterStart, appointmentFilterEnd]);

  const filterOptions = useMemo(() => {
    const advisors = new Set<string>();
    const customers = new Set<string>();
    const states = new Set<string>();
    dateFilteredReservations.forEach((r) => {
      const adv = advisorName(r);
      if (adv) advisors.add(adv);
      const cust = userName(r.attributes?.user);
      if (cust) customers.add(cust);
      const st = r.metadata?.currentState ?? '';
      if (st) states.add(st);
    });
    return {
      advisors: Array.from(advisors).sort(),
      customers: Array.from(customers).sort(),
      states: Array.from(states).sort(),
    };
  }, [dateFilteredReservations]);

  const todayReservations = reservations
    .filter((r) => (r.attributes?.startDateTime as string)?.startsWith?.(today))
    .sort((a, b) =>
      String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''))
    );

  const activePM = portfolioManagers.filter(isActiveStaff);
  const activeIA = investmentAdvisors.filter(isActiveStaff);

  const activeChats = chatRooms.filter((c) => {
    const st = c.metadata?.currentState;
    return st !== 'deactivated' && st !== 'complete' && st !== 'completed';
  });

  const slaBreachedCount = chatRooms.filter((c) => c.attributes?.slaBreached === true).length;

  const currentLeaves = absenceEntries.filter((a) => {
    const start = a.attributes?.startDateTime as string;
    const end = a.attributes?.endDateTime as string;
    if (!start) return false;
    const now = Date.now();
    const startMs = new Date(start).getTime();
    if (isNaN(startMs)) return false;
    const endMs = end ? new Date(end).getTime() : startMs + 86400000;
    if (isNaN(endMs)) return false;
    if (startMs > now || endMs < now) return false;
    const st = (a.metadata?.currentState ?? (a as unknown as Record<string, unknown>).currentState) as string | undefined;
    const validStates = ['active', 'approved', 'complete', 'complete-with-transfer'];
    return !st || validStates.includes(st);
  });

  const onLeaveStaff = currentLeaves.length;

  const allStaff = [...portfolioManagers, ...investmentAdvisors];

  const filteredLeaveEntries = useMemo(() => {
    return personalLeaveEntries
      .filter((a) => {
        const start = (a.attributes?.startDateTime as string)?.slice(0, 10);
        if (!start) return false;
        if (start < leaveFilterStart || start > leaveFilterEnd) return false;
        const advName = advisorDisplayName(a.attributes?.advisor, allStaff);
        if (leaveFilterAdvisor && advName !== leaveFilterAdvisor) return false;
        return true;
      })
      .sort((a, b) =>
        String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''))
      );
  }, [personalLeaveEntries, leaveFilterStart, leaveFilterEnd, leaveFilterAdvisor, allStaff]);

  const leaveFilterOptions = useMemo(() => {
    const advisors = new Set<string>();
    personalLeaveEntries.forEach((a) => {
      const name = advisorDisplayName(a.attributes?.advisor, allStaff);
      if (name) advisors.add(name);
    });
    return { advisors: Array.from(advisors).sort() };
  }, [personalLeaveEntries, allStaff]);

  return (
    <div className="page">
      <div className="page-header">
        <h1>Admin Dashboard</h1>
        <button
          className="btn btn-secondary btn-sm"
          onClick={fetchData}
          disabled={loading}
          title="Yenile"
        >
          <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
          Yenile
        </button>
      </div>

      {loading ? (
        <div className="empty-state">
          <RefreshCw size={40} className="animate-spin" />
          <p>Veriler yükleniyor...</p>
        </div>
      ) : (
        <>
          {/* Stat cards row */}
          <div className="page-grid" style={{ gridTemplateColumns: 'repeat(5, 1fr)' }}>
            <div className="card">
              <div className="card-header">
                <Briefcase size={20} />
                <h3>Portföy Yöneticileri</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{activePM.length} <span className="text-muted text-sm">/ {portfolioManagers.length}</span></p>
                <p className="text-muted text-sm">aktif PY</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <TrendingUp size={20} />
                <h3>Yatırım Danışmanları</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{activeIA.length} <span className="text-muted text-sm">/ {investmentAdvisors.length}</span></p>
                <p className="text-muted text-sm">aktif YD</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <CalendarDays size={20} />
                <h3>Günlük Randevular</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{todayReservations.length}</p>
                <p className="text-muted text-sm">bugün</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <MessageSquare size={20} />
                <h3>Aktif Chatler</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{activeChats.length}</p>
                <p className="text-muted text-sm">açık chat</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <CalendarOff size={20} />
                <h3>İzinli Personel</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{onLeaveStaff}</p>
                <p className="text-muted text-sm">şu an izinli</p>
              </div>
            </div>
          </div>

          {/* Takım Randevu Durumu */}
          <div className="card">
            <div className="card-header">
              <LayoutDashboard size={20} />
              <h3>Takım Randevu Durumu</h3>
            </div>
            <div className="card-body">
              <div className="flex flex-wrap gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <label htmlFor="appt-filter-start" className="text-sm text-muted">Başlangıç</label>
                  <input
                    id="appt-filter-start"
                    type="date"
                    value={appointmentFilterStart}
                    onChange={(e) => setAppointmentFilterStart(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="appt-filter-end" className="text-sm text-muted">Bitiş</label>
                  <input
                    id="appt-filter-end"
                    type="date"
                    value={appointmentFilterEnd}
                    onChange={(e) => setAppointmentFilterEnd(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="appt-filter-advisor" className="text-sm text-muted">Danışman</label>
                  <select
                    id="appt-filter-advisor"
                    value={appointmentFilterAdvisor}
                    onChange={(e) => setAppointmentFilterAdvisor(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Tümü</option>
                    {filterOptions.advisors.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="appt-filter-customer" className="text-sm text-muted">Müşteri</label>
                  <select
                    id="appt-filter-customer"
                    value={appointmentFilterCustomer}
                    onChange={(e) => setAppointmentFilterCustomer(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Tümü</option>
                    {filterOptions.customers.map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                  </select>
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="appt-filter-status" className="text-sm text-muted">Durum</label>
                  <select
                    id="appt-filter-status"
                    value={appointmentFilterStatus}
                    onChange={(e) => setAppointmentFilterStatus(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Tümü</option>
                    {filterOptions.states.map((s) => (
                      <option key={s} value={s}>{STATE_LABELS[s] ?? s}</option>
                    ))}
                  </select>
                </div>
              </div>
              {filteredReservations.length === 0 ? (
                <EmptyState
                  message={appointmentFilterStart === today && appointmentFilterEnd === today ? 'Bugün randevu yok' : 'Seçilen tarih aralığında randevu yok'}
                  icon={<CalendarDays size={40} strokeWidth={1.5} />}
                />
              ) : (
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Saat</th>
                        <th>Danışman</th>
                        <th>Müşteri</th>
                        <th>Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredReservations.map((r) => (
                        <tr key={r.key}>
                          <td>{formatDate(r.attributes?.startDateTime as string)}</td>
                          <td>
                            {formatTime(r.attributes?.startDateTime as string)} -{' '}
                            {formatTime(r.attributes?.endDateTime as string)}
                          </td>
                          <td>{advisorName(r)}</td>
                          <td>{userName(r.attributes?.user)}</td>
                          <td>
                            <Badge state={r.metadata?.currentState ?? '?'} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Takım İzin Takvimi */}
          <div className="card">
            <div className="card-header">
              <CalendarOff size={20} />
              <h3>Takım İzin Takvimi</h3>
            </div>
            <div className="card-body">
              <div className="flex flex-wrap gap-3 mb-4">
                <div className="flex items-center gap-2">
                  <label htmlFor="leave-filter-start" className="text-sm text-muted">Başlangıç</label>
                  <input
                    id="leave-filter-start"
                    type="date"
                    value={leaveFilterStart}
                    onChange={(e) => setLeaveFilterStart(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="leave-filter-end" className="text-sm text-muted">Bitiş</label>
                  <input
                    id="leave-filter-end"
                    type="date"
                    value={leaveFilterEnd}
                    onChange={(e) => setLeaveFilterEnd(e.target.value)}
                    className="form-input"
                  />
                </div>
                <div className="flex items-center gap-2">
                  <label htmlFor="leave-filter-advisor" className="text-sm text-muted">Danışman</label>
                  <select
                    id="leave-filter-advisor"
                    value={leaveFilterAdvisor}
                    onChange={(e) => setLeaveFilterAdvisor(e.target.value)}
                    className="form-input"
                  >
                    <option value="">Tümü</option>
                    {leaveFilterOptions.advisors.map((a) => (
                      <option key={a} value={a}>{a}</option>
                    ))}
                  </select>
                </div>
              </div>
              {filteredLeaveEntries.length === 0 ? (
                <EmptyState message="Seçilen filtrede izin kaydı yok" icon={<CalendarOff size={40} strokeWidth={1.5} />} />
              ) : (
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Danışman</th>
                        <th>Başlangıç</th>
                        <th>Bitiş</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredLeaveEntries.map((a) => (
                        <tr key={a.key}>
                          <td>{advisorDisplayName(a.attributes?.advisor, allStaff)}</td>
                          <td>{formatDateTime(a.attributes?.startDateTime as string)}</td>
                          <td>{formatDateTime(a.attributes?.endDateTime as string)}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>

          {/* Chat İstatistikleri */}
          <div className="card">
            <div className="card-header">
              <MessageSquare size={20} />
              <h3>Chat İstatistikleri</h3>
            </div>
            <div className="card-body">
              <div className="flex flex-col gap-3">
                <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--color-border)]">
                  <span className="text-sm">Aktif chat sayısı</span>
                  <span className="font-medium">{activeChats.length}</span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--color-border)]">
                  <span className="text-sm flex items-center gap-2">
                    SLA ihlali
                    {slaBreachedCount > 0 && <AlertTriangle size={14} className="text-[var(--color-danger)]" />}
                  </span>
                  <span className={cn('font-medium', slaBreachedCount > 0 && 'text-[var(--color-danger)]')}>
                    {slaBreachedCount}
                  </span>
                </div>
                <div className="flex items-center justify-between p-3 rounded-lg border border-[var(--color-border)]">
                  <span className="text-sm">Ortalama yanıt süresi</span>
                  <span className="text-muted text-sm">—</span>
                </div>
              </div>
            </div>
          </div>
        </>
      )}
    </div>
  );
}
