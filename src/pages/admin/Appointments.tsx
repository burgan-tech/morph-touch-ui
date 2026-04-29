import { useEffect, useState, useCallback } from 'react';
import {
  CalendarDays,
  Search,
  ArrowLeftRight,
  XCircle,
  Video,
  RefreshCw,
  User,
} from 'lucide-react';
import { getReservations, runTransition } from '../../lib/api';
import { formatDateTime, cn } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: string;
    advisor?: string;
    segment?: string;
    startDateTime?: string;
    endDateTime?: string;
    webrtcIntegration?: Record<string, unknown>;
    chatIntegration?: Record<string, unknown>;
  };
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function refDisplay(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

const STATUS_OPTIONS = [
  { value: '', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'completed', label: 'Tamamlandı' },
  { value: 'cancelled', label: 'İptal' },
] as const;

const ACTIVE_STATES = ['active', 'in-meet', 'awaiting-assignment', 'can-start-meeting', 'accept-terms'];
const COMPLETED_STATES = ['meet-completed', 'complete', 'completed'];
const CANCELLED_STATES = ['user-cancelled', 'advisor-cancelled', 'timeout', 'cancelled'];

function matchesStatusFilter(state: string, statusFilter: string): boolean {
  if (!statusFilter) return true;
  if (statusFilter === 'active') return ACTIVE_STATES.includes(state);
  if (statusFilter === 'completed') return COMPLETED_STATES.includes(state);
  if (statusFilter === 'cancelled') return CANCELLED_STATES.includes(state);
  return true;
}

export function Appointments() {
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [advisorFilter, setAdvisorFilter] = useState('');
  const [segmentFilter, setSegmentFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{
    startDate: string;
    endDate: string;
    advisor: string;
    segment: string;
    status: string;
  }>({ startDate: '', endDate: '', advisor: '', segment: '', status: '' });
  const [transferModal, setTransferModal] = useState<ReservationInstance | null>(null);
  const [transferAdvisorId, setTransferAdvisorId] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);
  const [cancelModal, setCancelModal] = useState<ReservationInstance | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);

  const fetchReservations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getReservations({ touchUser: 'admin', userType: 'admin' });
      const items = extractItems<ReservationInstance>(res);
      setReservations(items);
      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  const handleFilter = () => {
    setAppliedFilters({
      startDate,
      endDate,
      advisor: advisorFilter.trim(),
      segment: segmentFilter.trim(),
      status: statusFilter,
    });
  };

  const filteredReservations = reservations.filter((r) => {
    const state = r.metadata?.currentState ?? '';
    if (!matchesStatusFilter(state, appliedFilters.status)) return false;
    const advisor = refDisplay(r.attributes?.advisor).toLowerCase();
    const segment = (r.attributes?.segment ?? '').toString().toLowerCase();
    const user = refDisplay(r.attributes?.user).toLowerCase();
    const advisorMatch = !appliedFilters.advisor || advisor.includes(appliedFilters.advisor.toLowerCase());
    const segmentMatch =
      !appliedFilters.segment ||
      segment.includes(appliedFilters.segment.toLowerCase()) ||
      user.includes(appliedFilters.segment.toLowerCase());
    const start = r.attributes?.startDateTime;
    const dateMatch =
      (!appliedFilters.startDate || (start && start >= appliedFilters.startDate)) &&
      (!appliedFilters.endDate || (start && start.slice(0, 10) <= appliedFilters.endDate));
    return advisorMatch && segmentMatch && dateMatch;
  });

  const handleTransfer = async () => {
    const inst = transferModal;
    const instanceId = inst?.id ?? inst?.key;
    if (!instanceId || !transferAdvisorId.trim()) {
      toast('Lütfen danışman ID girin', 'error');
      return;
    }
    setTransferLoading(true);
    try {
      const res = await runTransition('rezervation', instanceId, 'transfer-to-advisor', {
        targetAdvisor: transferAdvisorId.trim(),
      });
      if (res.ok) {
        toast('Randevu transfer edildi', 'success');
        setTransferModal(null);
        setTransferAdvisorId('');
        fetchReservations();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setTransferLoading(false);
    }
  };

  const handleCancel = async () => {
    const inst = cancelModal;
    const instanceId = inst?.id ?? inst?.key;
    if (!instanceId) return;
    setCancelLoading(true);
    try {
      const res = await runTransition('rezervation', instanceId, 'advisor-cancel');
      if (res.ok) {
        toast('Randevu iptal edildi', 'success');
        setCancelModal(null);
        fetchReservations();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setCancelLoading(false);
    }
  };

  const handleJoinMeeting = (_r: ReservationInstance) => {
    toast('Görüşmeye bağlanılıyor...', 'info');
  };

  const canTransferOrCancel = (r: ReservationInstance) => {
    const s = r.metadata?.currentState ?? '';
    return s === 'active' || s === 'in-meet' || s === 'awaiting-assignment';
  };

  const canJoin = (r: ReservationInstance) => {
    const s = r.metadata?.currentState ?? '';
    return s === 'in-meet';
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Randevu Yönetimi (Admin)</h1>
      </div>
      <div className="page-grid page-grid-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CalendarDays size={20} />
              <h3>Randevular</h3>
            </div>
          </CardHeader>
          <CardBody>
            <div className="filter-row">
              <div className="form-group">
                <label className="form-label">Başlangıç Tarihi</label>
                <input
                  type="date"
                  className="form-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Bitiş Tarihi</label>
                <input
                  type="date"
                  className="form-input"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Personel</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Danışman ID"
                  value={advisorFilter}
                  onChange={(e) => setAdvisorFilter(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Segment</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Segment"
                  value={segmentFilter}
                  onChange={(e) => setSegmentFilter(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Durum</label>
                <select
                  className="form-input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <button className="btn btn-primary" onClick={handleFilter}>
                <Search size={16} />
                Filtrele
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={fetchReservations}
                disabled={loading}
              >
                <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
                Yenile
              </button>
            </div>

            {loading ? (
              <div className="empty-state">
                <div
                  className="animate-spin"
                  style={{
                    width: 32,
                    height: 32,
                    border: '3px solid var(--color-border)',
                    borderTopColor: 'var(--color-primary)',
                    borderRadius: '50%',
                  }}
                />
                <p>Yükleniyor...</p>
              </div>
            ) : filteredReservations.length === 0 ? (
              <EmptyState
                message="Randevu bulunamadı"
                icon={<CalendarDays size={40} strokeWidth={1.5} />}
              />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tarih/Saat</th>
                      <th>Personel</th>
                      <th>Müşteri</th>
                      <th>Durum</th>
                      <th>İşlemler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredReservations.map((r) => {
                      const state = r.metadata?.currentState ?? '';
                      const canAct = canTransferOrCancel(r);
                      const showJoin = canJoin(r);
                      return (
                        <tr key={r.id ?? r.key}>
                          <td>
                            <span className="text-sm">{formatDateTime(r.attributes?.startDateTime)}</span>
                          </td>
                          <td>
                            <div className="flex items-center gap-2">
                              <User size={14} className="text-muted" />
                              {refDisplay(r.attributes?.advisor)}
                            </div>
                          </td>
                          <td>{refDisplay(r.attributes?.user)}</td>
                          <td>
                            <Badge state={state} />
                          </td>
                          <td>
                            <div className="flex gap-2">
                              <button
                                type="button"
                                className="btn btn-sm btn-secondary"
                                disabled={!canAct}
                                onClick={() => {
                                  setTransferModal(r);
                                  setTransferAdvisorId('');
                                }}
                              >
                                <ArrowLeftRight size={14} />
                                Transfer
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-danger"
                                disabled={!canAct}
                                onClick={() => setCancelModal(r)}
                              >
                                <XCircle size={14} />
                                İptal
                              </button>
                              <button
                                type="button"
                                className="btn btn-sm btn-primary"
                                disabled={!showJoin}
                                onClick={() => handleJoinMeeting(r)}
                              >
                                <Video size={14} />
                                Bağlan
                              </button>
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Transfer modal */}
      <Modal
        open={!!transferModal}
        onClose={() => {
          setTransferModal(null);
          setTransferAdvisorId('');
        }}
        title="Randevu Transfer"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setTransferModal(null);
                setTransferAdvisorId('');
              }}
            >
              Hayır
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={transferLoading || !transferAdvisorId.trim()}
              onClick={handleTransfer}
            >
              {transferLoading ? 'İşleniyor...' : 'Onayla'}
            </button>
          </>
        }
      >
        {transferModal && (
          <div className="form-group">
            <label className="form-label">Hedef Danışman ID</label>
            <input
              type="text"
              className="form-input"
              placeholder="advisor-2"
              value={transferAdvisorId}
              onChange={(e) => setTransferAdvisorId(e.target.value)}
            />
          </div>
        )}
      </Modal>

      {/* Cancel confirmation modal */}
      <Modal
        open={!!cancelModal}
        onClose={() => setCancelModal(null)}
        title="Randevu İptali"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={() => setCancelModal(null)}>
              Hayır
            </button>
            <button
              type="button"
              className="btn btn-danger"
              disabled={cancelLoading}
              onClick={handleCancel}
            >
              {cancelLoading ? 'İşleniyor...' : 'Evet'}
            </button>
          </>
        }
      >
        <p>Bu randevuyu iptal etmek istediğinize emin misiniz?</p>
      </Modal>
    </div>
  );
}
