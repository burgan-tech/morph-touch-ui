import { useEffect, useState, useCallback, useMemo } from 'react';
import {
  CalendarDays,
  Search,
  UserPlus,
  XCircle,
  FileText,
  User,
  Clock,
  Video,
  RefreshCw,
} from 'lucide-react';
import { getReservations, runTransition, startInstance, getInstance } from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';
import { useAdvisorContext } from '../../contexts/AdvisorContext';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: string;
    advisor?: string;
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

function userName(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function durationMinutes(start?: string, end?: string): string {
  if (!start || !end) return '—';
  const s = new Date(start).getTime();
  const e = new Date(end).getTime();
  const mins = Math.round((e - s) / 60000);
  return mins > 0 ? `${mins} dk` : '—';
}

const STATUS_OPTIONS = [
  { value: '', label: 'Tümü' },
  { value: 'active', label: 'Aktif' },
  { value: 'completed', label: 'Tamamlandı' },
  { value: 'cancelled', label: 'İptal' },
] as const;

/** Müşteri dashboard ile aynı: bu durumlarda “yakında başlayacak” penceresi uygulanır */
const FIFTEEN_MIN_MS = 15 * 60 * 1000;

function isActiveLikeForSoon(state: string): boolean {
  return (
    state === 'active' ||
    state === 'in-meet' ||
    state === 'accept-terms' ||
    state === 'can-start-meeting'
  );
}

/**
 * Başlayanlar: in-meet (görüşmede) olanlar + planlanan başlangıca göre “15 dk önce - bitişe kadar” penceresindeki aktif-benzeri randevular.
 * Pencere: başlangıca ≤15 dk kala ve endDateTime geçene kadar.
 * Kalanlar “diğer randevular”.
 */
function splitStartersAndOther(reservations: ReservationInstance[]): {
  starters: ReservationInstance[];
  other: ReservationInstance[];
} {
  const now = Date.now();
  const starterKeys = new Set<string>();
  const starters: ReservationInstance[] = [];

  for (const r of reservations) {
    if ((r.metadata?.currentState ?? '') === 'in-meet') {
      starters.push(r);
      starterKeys.add(r.id ?? r.key);
    }
  }

  for (const r of reservations) {
    if (starterKeys.has(r.id ?? r.key)) continue;
    const state = r.metadata?.currentState ?? '';
    if (!isActiveLikeForSoon(state)) continue;
    const start = r.attributes?.startDateTime;
    const end = r.attributes?.endDateTime;
    if (!start || !end) continue;
    const startTs = new Date(start).getTime();
    const endTs = new Date(end).getTime();
    const inWindow = now >= startTs - FIFTEEN_MIN_MS && now <= endTs;
    if (inWindow) {
      starters.push(r);
      starterKeys.add(r.id ?? r.key);
    }
  }

  starters.sort((a, b) => {
    const aMeet = (a.metadata?.currentState ?? '') === 'in-meet' ? 0 : 1;
    const bMeet = (b.metadata?.currentState ?? '') === 'in-meet' ? 0 : 1;
    if (aMeet !== bMeet) return aMeet - bMeet;
    return String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''));
  });

  const other = reservations.filter((r) => !starterKeys.has(r.id ?? r.key));
  return { starters, other };
}

function canStartVideoMeet(state: string): boolean {
  return (
    state === 'active' ||
    state === 'in-meet' ||
    state === 'accept-terms' ||
    state === 'can-start-meeting'
  );
}

export function Appointments() {
  const ADVISOR_ID = useAdvisorContext().advisorId!;
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{ startDate: string; endDate: string; status: string }>({ startDate: '', endDate: '', status: '' });
  const [customerModal, setCustomerModal] = useState<{ user: string } | null>(null);
  const [addParticipantModal, setAddParticipantModal] = useState<ReservationInstance | null>(null);
  const [addParticipantUserId, setAddParticipantUserId] = useState('');
  const [addParticipantLoading, setAddParticipantLoading] = useState(false);
  const [cancelModal, setCancelModal] = useState<ReservationInstance | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [startMeetLoading, setStartMeetLoading] = useState<string | null>(null);
  const [videoCallModal, setVideoCallModal] = useState<{
    reservation: ReservationInstance;
    status: 'starting' | 'waiting' | 'ready';
    videoUrl: string | null;
  } | null>(null);

  const fetchReservations = useCallback(async (filters: { startDate: string; endDate: string; status: string }) => {
    setLoading(true);
    try {
      const res = await getReservations({ touchUser: ADVISOR_ID, userType: 'advisor' });
      let items = extractItems<ReservationInstance>(res);
      if (filters.startDate) {
        items = items.filter((r) => {
          const start = r.attributes?.startDateTime ?? '';
          return start >= filters.startDate;
        });
      }
      if (filters.endDate) {
        items = items.filter((r) => {
          const day = (r.attributes?.startDateTime ?? '').slice(0, 10);
          return day <= filters.endDate;
        });
      }
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
  }, [ADVISOR_ID]);

  useEffect(() => {
    fetchReservations(appliedFilters);
  }, [fetchReservations, appliedFilters]);

  useEffect(() => {
    if (!videoCallModal || videoCallModal.status !== 'waiting' || !ADVISOR_ID) return;
    const r = videoCallModal.reservation;
    const id = r.id ?? r.key;
    const advRef = r.attributes?.advisor;
    const advisorAttrKey =
      typeof advRef === 'string'
        ? advRef
        : advRef && typeof advRef === 'object' && 'key' in advRef
          ? String((advRef as { key: string }).key)
          : '';
    let cancelled = false;

    const pickAdvisorUrl = (urls: Record<string, string>[]): string | null => {
      for (const u of urls) {
        if (!u) continue;
        if (ADVISOR_ID in u && u[ADVISOR_ID]) return u[ADVISOR_ID];
      }
      if (advisorAttrKey) {
        for (const u of urls) {
          if (!u) continue;
          if (advisorAttrKey in u && u[advisorAttrKey]) return u[advisorAttrKey];
        }
      }
      return null;
    };

    const poll = async () => {
      try {
        const res = await getInstance('rezervation', id);
        if (cancelled) return;
        const data = res.data as {
          attributes?: { videoCallUrls?: Record<string, string>[] };
          videoCallUrls?: Record<string, string>[];
        } | null;
        const urls = data?.attributes?.videoCallUrls ?? data?.videoCallUrls;
        if (urls && Array.isArray(urls) && urls.length > 0) {
          const url = pickAdvisorUrl(urls);
          if (url) {
            window.open(url, '_blank', 'noopener,noreferrer');
            setVideoCallModal((prev) => (prev ? { ...prev, status: 'ready', videoUrl: url } : null));
            return;
          }
        }
      } catch {
        /* retry */
      }
      if (!cancelled) setTimeout(poll, 3000);
    };
    const timer = setTimeout(poll, 2000);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [videoCallModal?.status, videoCallModal?.reservation?.key, ADVISOR_ID]);

  const handleStartVideoMeet = async (r: ReservationInstance) => {
    if (!r.key) return;
    setStartMeetLoading(r.key);
    setVideoCallModal({ reservation: r, status: 'starting', videoUrl: null });
    try {
      const res = await startInstance('rezervation-start', {
        key: `rezervation-start-${Date.now()}`,
        tags: ['rezervation-start'],
        attributes: { randevuKey: r.key, participantType: 'advisor' },
      });
      if (res.ok) {
        setVideoCallModal((prev) => (prev ? { ...prev, status: 'waiting' } : null));
        fetchReservations(appliedFilters);
      } else {
        const err = (res.data as Record<string, unknown>)?.error ?? 'Görüşme başlatılamadı';
        toast(String(err), 'error');
        setVideoCallModal(null);
      }
    } catch (e) {
      toast(String(e), 'error');
      setVideoCallModal(null);
    } finally {
      setStartMeetLoading(null);
    }
  };

  const handleFilter = () => {
    setAppliedFilters({ startDate, endDate, status: statusFilter });
  };

  const handleAddParticipant = async () => {
    if (!addParticipantModal?.key || !addParticipantUserId.trim()) {
      toast('Lütfen kullanıcı ID girin', 'error');
      return;
    }
    setAddParticipantLoading(true);
    try {
      const res = await startInstance('add-participant-to-rezervation', {
        key: `add-participant-${Date.now()}`,
        tags: ['rezervation', 'add-participant'],
        attributes: {
          randevuKey: addParticipantModal.key,
          newUserId: addParticipantUserId.trim(),
        },
      });
      if (res.ok) {
        toast('Katılımcı eklendi', 'success');
        setAddParticipantModal(null);
        setAddParticipantUserId('');
        fetchReservations(appliedFilters);
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAddParticipantLoading(false);
    }
  };

  const handleCancel = async () => {
    if (!cancelModal?.id) return;
    setCancelLoading(true);
    try {
      const res = await runTransition('rezervation', cancelModal.id, 'cancel');
      if (res.ok) {
        toast('Randevu iptal edildi', 'success');
        setCancelModal(null);
        fetchReservations(appliedFilters);
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setCancelLoading(false);
    }
  };

  const canTransferOrCancel = (r: ReservationInstance) => {
    const s = r.metadata?.currentState ?? '';
    return s === 'active' || s === 'in-meet' || s === 'awaiting-assignment';
  };

  const { starters: reservationsStarters, other: reservationsOther } = useMemo(
    () => splitStartersAndOther(reservations),
    [reservations]
  );

  const renderReservationsTable = (items: ReservationInstance[], opts?: { showVideoStart?: boolean }) => (
    <div className="table-wrapper">
      <table className="table">
        <thead>
          <tr>
            <th>Tarih/Saat</th>
            <th>Müşteri</th>
            <th>Durum</th>
            <th>Süre</th>
            <th>İşlemler</th>
          </tr>
        </thead>
        <tbody>
          {items.map((r) => {
            const state = r.metadata?.currentState ?? '';
            const canAct = canTransferOrCancel(r);
            const showVideo = opts?.showVideoStart && canStartVideoMeet(state);
            return (
              <tr key={r.id ?? r.key}>
                <td>
                  <div className="flex items-center gap-2">
                    <Clock size={14} className="text-muted" />
                    {formatDateTime(r.attributes?.startDateTime)}
                  </div>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-sm btn-secondary"
                    onClick={() => setCustomerModal({ user: userName(r.attributes?.user) })}
                  >
                    <User size={14} />
                    {userName(r.attributes?.user)}
                  </button>
                </td>
                <td>
                  <Badge state={state} />
                </td>
                <td>
                  {durationMinutes(r.attributes?.startDateTime, r.attributes?.endDateTime)}
                </td>
                <td>
                  <div className="flex gap-2 flex-wrap">
                    {showVideo && (
                      <button
                        type="button"
                        className="btn btn-sm btn-primary"
                        disabled={startMeetLoading === r.key}
                        onClick={() => handleStartVideoMeet(r)}
                        title="Görüntülü görüşme başlat"
                      >
                        {startMeetLoading === r.key ? (
                          <RefreshCw size={14} className="animate-spin" />
                        ) : (
                          <Video size={14} />
                        )}
                        Görüntülü görüşme başlat
                      </button>
                    )}
                    <button
                      type="button"
                      className="btn btn-sm btn-secondary"
                      disabled={!canAct}
                      onClick={() => {
                        setAddParticipantModal(r);
                        setAddParticipantUserId('');
                      }}
                    >
                      <UserPlus size={14} />
                      Kişi ekle
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
                  </div>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Randevu Yönetimi</h1>
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
            </div>

            {loading ? (
              <div className="empty-state">
                <div className="animate-spin" style={{ width: 32, height: 32, border: '3px solid var(--color-border)', borderTopColor: 'var(--color-primary)', borderRadius: '50%' }} />
                <p>Yükleniyor...</p>
              </div>
            ) : reservations.length === 0 ? (
              <EmptyState message="Randevu bulunamadı" icon={<CalendarDays size={40} strokeWidth={1.5} />} />
            ) : (
              <div className="flex flex-col gap-6">
                <section
                  className="rounded-lg border p-4"
                  style={{
                    borderColor: 'var(--color-primary, #3b82f6)',
                    background: 'var(--color-primary-soft, rgba(59, 130, 246, 0.06))',
                  }}
                >
                  <h4 className="text-sm font-semibold mb-3 flex items-center gap-2">
                    <Clock size={18} />
                    Başlayanlar
                  </h4>
                  <p className="text-muted text-xs mb-3 m-0">
                    Görüşmede olanlar; başlangıca en fazla 15 dk kala başlayan ve bitiş saatine kadar süren aktif randevular
                  </p>
                  {reservationsStarters.length === 0 ? (
                    <p className="text-muted text-sm m-0">Bu aralıkta kayıt yok</p>
                  ) : (
                    renderReservationsTable(reservationsStarters, { showVideoStart: true })
                  )}
                </section>
                <section>
                  <h4 className="text-sm font-semibold mb-3">Diğer randevular</h4>
                  {reservationsOther.length === 0 ? (
                    <p className="text-muted text-sm m-0">Bu filtreyle başka randevu yok</p>
                  ) : (
                    renderReservationsTable(reservationsOther)
                  )}
                </section>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Customer card modal */}
      <Modal
        open={!!customerModal}
        onClose={() => setCustomerModal(null)}
        title="Müşteri Bilgileri"
      >
        {customerModal && (
          <>
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-2">
                <User size={18} />
                <span className="font-medium">{customerModal.user}</span>
              </div>
              <p className="text-muted text-sm">Müşteri detayları placeholder</p>
              <button type="button" className="btn btn-secondary" disabled title="Plan dahilinde değil">
                <FileText size={16} />
                Memo Ekle
              </button>
            </div>
          </>
        )}
      </Modal>

      {/* Kişi ekle — add-participant-to-rezervation */}
      <Modal
        open={!!addParticipantModal}
        onClose={() => {
          setAddParticipantModal(null);
          setAddParticipantUserId('');
        }}
        title="Randevuya kişi ekle"
        footer={
          <>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                setAddParticipantModal(null);
                setAddParticipantUserId('');
              }}
            >
              Vazgeç
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={addParticipantLoading || !addParticipantUserId.trim()}
              onClick={handleAddParticipant}
            >
              {addParticipantLoading ? 'İşleniyor...' : 'Ekle'}
            </button>
          </>
        }
      >
        {addParticipantModal && (
          <div className="form-group">
            <label className="form-label">Yeni katılımcı kullanıcı ID</label>
            <input
              type="text"
              className="form-input"
              placeholder="pm-002"
              value={addParticipantUserId}
              onChange={(e) => setAddParticipantUserId(e.target.value)}
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

      {/* Görüntülü görüşme — müşteri dashboard ile aynı akış; URL hazır olunca yeni sekme */}
      <Modal
        open={!!videoCallModal}
        onClose={() => setVideoCallModal(null)}
        title="Görüntülü Görüşme"
        footer={
          videoCallModal?.status === 'ready' && videoCallModal.videoUrl ? (
            <>
              <button type="button" className="btn btn-secondary" onClick={() => setVideoCallModal(null)}>
                Kapat
              </button>
              <a
                href={videoCallModal.videoUrl}
                target="_blank"
                rel="noreferrer"
                className="btn btn-primary"
              >
                <Video size={16} /> Yeni sekmede aç
              </a>
            </>
          ) : (
            <button type="button" className="btn btn-secondary" onClick={() => setVideoCallModal(null)}>
              İptal
            </button>
          )
        }
      >
        {videoCallModal?.status === 'starting' && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <RefreshCw size={32} className="animate-spin" style={{ margin: '0 auto 16px', display: 'block' }} />
            <p>Bağlantınız kuruluyor...</p>
          </div>
        )}
        {videoCallModal?.status === 'waiting' && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Video size={48} strokeWidth={1.5} style={{ margin: '0 auto 16px', display: 'block', color: 'var(--color-primary)' }} />
            <p style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>Görüşme bağlantısı hazırlanıyor</p>
            <p className="text-muted">Hazır olduğunda görüntülü görüşme yeni sekmede açılacaktır.</p>
            <RefreshCw size={20} className="animate-spin" style={{ margin: '16px auto 0', display: 'block', color: 'var(--color-muted)' }} />
          </div>
        )}
        {videoCallModal?.status === 'ready' && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Video size={48} strokeWidth={1.5} style={{ margin: '0 auto 16px', display: 'block', color: 'var(--color-success, #16a34a)' }} />
            <p style={{ fontWeight: 600, fontSize: 16 }}>Görüntülü görüşme hazır</p>
            <p className="text-muted">Bağlantı yeni sekmede açıldı; tekrar açmak için aşağıdaki butonu kullanın.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
