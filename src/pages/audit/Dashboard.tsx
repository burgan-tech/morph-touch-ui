import { useEffect, useState, useCallback } from 'react';
import { Video, MessageSquare, History, RefreshCw, User } from 'lucide-react';
import { getReservations, listInstances } from '../../lib/api';
import { formatDateTime, formatDuration, cn } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, toast } from '../../components/ui';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: unknown;
    advisor?: unknown;
    startDateTime?: string;
    endDateTime?: string;
  };
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ChatRoomInstance {
  key: string;
  id?: string;
  attributes: {
    user?: unknown;
    advisorId?: string;
    advisor?: unknown;
    roomType?: string;
  };
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  [key: string]: unknown;
}

function extractReservations<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function extractChatRooms<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function refDisplay(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function getRoomTypeLabel(roomType?: string): string {
  return roomType === 'permanent' ? 'Kalıcı' : roomType === 'rezervation' ? 'Randevu' : roomType ?? '—';
}

export function Dashboard() {
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [chatRooms, setChatRooms] = useState<ChatRoomInstance[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [rezRes, chatRes] = await Promise.all([
        getReservations({ touchUser: 'admin', userType: 'admin' }),
        listInstances('chat-room', { pageSize: 50 }),
      ]);

      const rezItems = extractReservations<ReservationInstance>(rezRes);
      const chatItems = extractChatRooms<ChatRoomInstance>(chatRes);

      setReservations(rezItems);
      setChatRooms(chatItems);

      if (!rezRes.ok || !chatRes.ok) {
        const err =
          (rezRes.data as Record<string, unknown>)?.error ??
          (chatRes.data as Record<string, unknown>)?.error;
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

  const completedReservations = reservations
    .filter((r) => {
      const s = r.metadata?.currentState ?? '';
      return ['meet-completed', 'complete', 'completed'].includes(s);
    })
    .sort((a, b) =>
      String(b.attributes?.startDateTime ?? '').localeCompare(String(a.attributes?.startDateTime ?? ''))
    )
    .slice(0, 50);

  const recentChatRooms = [...chatRooms]
    .sort((a, b) => {
      const aUp = a.metadata?.updatedAt ?? a.metadata?.createdAt ?? '';
      const bUp = b.metadata?.updatedAt ?? b.metadata?.createdAt ?? '';
      return bUp.localeCompare(aUp);
    })
    .slice(0, 50);

  const totalVideoRecords = reservations.filter((r) => {
    const s = r.metadata?.currentState ?? '';
    return ['meet-completed', 'complete', 'completed'].includes(s);
  }).length;

  return (
    <div className="page">
      <div className="page-header">
        <h1>Audit Dashboard</h1>
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
          {/* Stat cards */}
          <div className="page-grid">
            <Card>
              <CardHeader>
                <Video size={20} />
                <h3>Toplam Görüşme Kaydı</h3>
              </CardHeader>
              <CardBody>
                <p className="card-stat">{totalVideoRecords}</p>
                <p className="text-muted text-sm">tamamlanmış görüşme</p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <MessageSquare size={20} />
                <h3>Chat Kayıtları</h3>
              </CardHeader>
              <CardBody>
                <p className="card-stat">{chatRooms.length}</p>
                <p className="text-muted text-sm">chat odası</p>
              </CardBody>
            </Card>

            <Card>
              <CardHeader>
                <History size={20} />
                <h3>Son İşlemler</h3>
              </CardHeader>
              <CardBody>
                <p className="card-stat">{reservations.length}</p>
                <p className="text-muted text-sm">toplam randevu</p>
              </CardBody>
            </Card>
          </div>

          {/* Son Görüşmeler */}
          <Card>
            <CardHeader>
              <Video size={20} />
              <h3>Son Görüşmeler</h3>
            </CardHeader>
            <CardBody>
              {completedReservations.length === 0 ? (
                <EmptyState
                  message="Tamamlanmış görüşme bulunamadı"
                  icon={<Video size={40} strokeWidth={1.5} />}
                />
              ) : (
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Tarih</th>
                        <th>Danışman</th>
                        <th>Müşteri</th>
                        <th>Süre</th>
                        <th>Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {completedReservations.map((r) => (
                        <tr key={r.id ?? r.key}>
                          <td className="text-sm">{formatDateTime(r.attributes?.startDateTime)}</td>
                          <td>
                            <div className="flex items-center gap-2">
                              <User size={14} className="text-muted" />
                              {refDisplay(r.attributes?.advisor)}
                            </div>
                          </td>
                          <td>{refDisplay(r.attributes?.user)}</td>
                          <td className="text-sm">
                            {formatDuration(r.attributes?.startDateTime, r.attributes?.endDateTime)}
                          </td>
                          <td>
                            <Badge state={r.metadata?.currentState ?? ''} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>

          {/* Son Chat Aktivitesi */}
          <Card>
            <CardHeader>
              <MessageSquare size={20} />
              <h3>Son Chat Aktivitesi</h3>
            </CardHeader>
            <CardBody>
              {recentChatRooms.length === 0 ? (
                <EmptyState
                  message="Chat kaydı bulunamadı"
                  icon={<MessageSquare size={40} strokeWidth={1.5} />}
                />
              ) : (
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Müşteri</th>
                        <th>Danışman</th>
                        <th>Oda Tipi</th>
                        <th>Durum</th>
                      </tr>
                    </thead>
                    <tbody>
                      {recentChatRooms.map((r) => (
                        <tr key={r.id ?? r.key}>
                          <td>{refDisplay(r.attributes?.user)}</td>
                          <td>
                            {refDisplay(r.attributes?.advisorId ?? r.attributes?.advisor)}
                          </td>
                          <td>{getRoomTypeLabel(r.attributes?.roomType)}</td>
                          <td>
                            <Badge state={r.metadata?.currentState ?? ''} />
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </CardBody>
          </Card>
        </>
      )}
    </div>
  );
}
