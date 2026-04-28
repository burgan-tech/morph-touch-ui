import { useEffect, useState, useCallback } from 'react';
import {
  Video,
  MessageSquare,
  ArrowLeftRight,
  RefreshCw,
  AlertTriangle,
} from 'lucide-react';
import { listInstances, runTransition } from '../../lib/api';
import { formatDateTime, formatDuration, cn } from '../../lib/utils';
import {
  Card,
  CardHeader,
  CardBody,
  EmptyState,
  Modal,
  toast,
} from '../../components/ui';

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
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

function customerName(inst: VnextInstance): string {
  return userName(inst.attributes?.user);
}

function isSlaPending(room: VnextInstance): boolean {
  const lastMsg = room.attributes?.lastMessageAt as string | undefined;
  const lastRead = room.attributes?.lastReadAt as string | undefined;
  if (!lastMsg) return false;
  if (!lastRead) return true;
  return new Date(lastMsg).getTime() > new Date(lastRead).getTime();
}

export function Communications() {
  const [loading, setLoading] = useState(true);
  const [activeMeetings, setActiveMeetings] = useState<VnextInstance[]>([]);
  const [chatRooms, setChatRooms] = useState<VnextInstance[]>([]);
  const [transferModal, setTransferModal] = useState<VnextInstance | null>(null);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [transferLoading, setTransferLoading] = useState(false);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [rezRes, chatRes] = await Promise.all([
        listInstances('rezervation', { pageSize: 100, currentState: 'in-meet' }),
        listInstances('chat-room', { pageSize: 100 }),
      ]);

      const rezItems = extractItems<VnextInstance>(rezRes);
      const allChats = extractItems<VnextInstance>(chatRes);
      const activeChats = allChats.filter(
        (r) =>
          r.metadata?.currentState !== 'deactivated' && r.metadata?.currentState !== 'completed'
      );

      setActiveMeetings(rezItems);
      setChatRooms(activeChats);

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

  const handleJoinMeeting = () => {
    toast('Görüşmeye bağlanılıyor...', 'info');
  };

  const handleTransfer = async () => {
    const room = transferModal;
    const instanceId = room?.id ?? room?.key;
    if (!instanceId || !transferTargetId.trim()) {
      toast('Hedef danışman ID gerekli', 'error');
      return;
    }
    setTransferLoading(true);
    try {
      const res = await runTransition('chat-room', instanceId, 'transfer', {
        attributes: { newAdvisorId: transferTargetId.trim() },
      });
      if (res.ok) {
        toast('Chat başarıyla devredildi', 'success');
        setTransferModal(null);
        setTransferTargetId('');
        fetchData();
      } else {
        const err = (res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`;
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setTransferLoading(false);
    }
  };

  const openTransferModal = (room: VnextInstance) => {
    setTransferModal(room);
    setTransferTargetId('');
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Görüntülü Görüşme & Chat Yönetimi</h1>
        <button
          className="btn btn-secondary"
          onClick={fetchData}
          disabled={loading}
        >
          <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
          Yenile
        </button>
      </div>

      <div className="page-grid-full">
        {/* 1. Aktif Görüşmeler (Video Calls) */}
        <Card>
          <CardHeader>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <Video size={20} />
              <h3>Aktif Görüşmeler</h3>
            </div>
          </CardHeader>
          <CardBody>
            {loading ? (
              <p className="text-muted text-sm">Yükleniyor...</p>
            ) : activeMeetings.length === 0 ? (
              <EmptyState message="Aktif görüşme yok" icon={<Video size={40} strokeWidth={1.5} />} />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Danışman</th>
                      <th>Müşteri</th>
                      <th>Başlangıç Saati</th>
                      <th>Süre</th>
                      <th>İşlemler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activeMeetings.map((r) => (
                      <tr key={r.key}>
                        <td>{advisorName(r)}</td>
                        <td>{customerName(r)}</td>
                        <td>{formatDateTime(r.attributes?.startDateTime as string)}</td>
                        <td>
                          {formatDuration(
                            r.attributes?.startDateTime as string,
                            r.attributes?.endDateTime as string
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn-primary btn-sm"
                            onClick={() => handleJoinMeeting()}
                          >
                            Bağlan
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        {/* 2. Açık Chatler */}
        <Card>
          <CardHeader>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <MessageSquare size={20} />
              <h3>Açık Chatler</h3>
            </div>
          </CardHeader>
          <CardBody>
            {loading ? (
              <p className="text-muted text-sm">Yükleniyor...</p>
            ) : chatRooms.length === 0 ? (
              <EmptyState
                message="Açık chat bulunamadı"
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
                      <th>Son Mesaj</th>
                      <th>SLA Durumu</th>
                      <th>İşlemler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {chatRooms.map((room) => (
                      <tr key={room.key}>
                        <td>{customerName(room)}</td>
                        <td>{advisorName(room)}</td>
                        <td>
                          {room.attributes?.roomType === 'permanent' ? 'Kalıcı' : 'Randevu'}
                        </td>
                        <td className="text-muted text-sm">
                          {room.attributes?.lastMessageAt
                            ? formatDateTime(room.attributes.lastMessageAt as string)
                            : '—'}
                        </td>
                        <td>
                          {isSlaPending(room) ? (
                            <span style={{ color: 'var(--color-danger)', display: 'flex', alignItems: 'center', gap: 4 }}>
                              <AlertTriangle size={14} />
                              Yanıt Bekliyor
                            </span>
                          ) : (
                            <span className="text-muted text-sm">Tamamlandı</span>
                          )}
                        </td>
                        <td>
                          <button
                            className="btn btn-secondary btn-sm"
                            onClick={() => openTransferModal(room)}
                          >
                            Devret
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        {/* 3. Chat/Görüşme Devri - integrated via Devret button in table */}
        <Card>
          <CardHeader>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <ArrowLeftRight size={20} />
              <h3>Chat/Görüşme Devri</h3>
            </div>
          </CardHeader>
          <CardBody>
            <p className="text-muted text-sm">
              Yukarıdaki chat tablosundaki &quot;Devret&quot; butonu ile bir chat odasını başka bir
              danışmana devredebilirsiniz.
            </p>
          </CardBody>
        </Card>
      </div>

      {/* Transfer Modal */}
      <Modal
        open={!!transferModal}
        onClose={() => {
          setTransferModal(null);
          setTransferTargetId('');
        }}
        title="Chat Devret"
        footer={
          <>
            <button
              className="btn btn-secondary"
              onClick={() => {
                setTransferModal(null);
                setTransferTargetId('');
              }}
            >
              İptal
            </button>
            <button
              className="btn btn-primary"
              onClick={handleTransfer}
              disabled={transferLoading || !transferTargetId.trim()}
            >
              {transferLoading ? 'İşleniyor...' : 'Devret'}
            </button>
          </>
        }
      >
        {transferModal && (
          <>
            <div className="form-group">
              <label className="form-label">Mevcut oda</label>
              <p className="text-sm">
                {customerName(transferModal)} — {advisorName(transferModal)}
              </p>
            </div>
            <div className="form-group">
              <label className="form-label">Hedef danışman ID</label>
              <input
                type="text"
                className="form-input"
                placeholder="örn: pm-002"
                value={transferTargetId}
                onChange={(e) => setTransferTargetId(e.target.value)}
              />
            </div>
          </>
        )}
      </Modal>
    </div>
  );
}
