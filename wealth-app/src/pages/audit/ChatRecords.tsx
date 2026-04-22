import { useEffect, useState, useCallback } from 'react';
import { MessageSquare, Search, RefreshCw, User } from 'lucide-react';
import { listInstances, getRoomMessages } from '../../lib/api';
import { formatDateTime, formatTime, cn } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';

interface ChatRoomInstance {
  key: string;
  id?: string;
  attributes: {
    user?: unknown;
    advisorId?: string;
    advisor?: unknown;
    roomType?: string;
    chatIntegration?: {
      matrix?: { roomId?: string };
    };
  };
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ChatMessage {
  eventId?: string;
  sender?: string;
  body?: string;
  content?: string;
  timestamp?: string | number;
  msgtype?: string;
}

interface ApiData<T> {
  items?: T[];
  [key: string]: unknown;
}

function extractChatRooms<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function extractMessages(res: { ok: boolean; data?: unknown }): ChatMessage[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;
  const nested = d.getRoomMessages as { messages?: ChatMessage[] } | undefined;
  const messages =
    (d.messages as ChatMessage[] | undefined) ?? nested?.messages ?? [];
  return Array.isArray(messages) ? messages : [];
}

function refDisplay(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref)
    return String((ref as { key: string }).key);
  return '—';
}

function getRoomTypeLabel(roomType?: string): string {
  return roomType === 'permanent'
    ? 'Kalıcı'
    : roomType === 'rezervation'
      ? 'Randevu'
      : roomType ?? '—';
}

function getMatrixRoomId(room: ChatRoomInstance): string | null {
  return room.attributes?.chatIntegration?.matrix?.roomId ?? null;
}

export function ChatRecords() {
  const [loading, setLoading] = useState(true);
  const [chatRooms, setChatRooms] = useState<ChatRoomInstance[]>([]);
  const [customerFilter, setCustomerFilter] = useState('');
  const [advisorFilter, setAdvisorFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{
    customer: string;
    advisor: string;
    startDate: string;
    endDate: string;
  }>({ customer: '', advisor: '', startDate: '', endDate: '' });
  const [detailModal, setDetailModal] = useState<ChatRoomInstance | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);

  const fetchRooms = useCallback(async () => {
    setLoading(true);
    try {
      const res = await listInstances('chat-room', { pageSize: 100 });
      const items = extractChatRooms<ChatRoomInstance>(res);
      setChatRooms(items);

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
    fetchRooms();
  }, [fetchRooms]);

  const fetchMessages = useCallback(async (room: ChatRoomInstance) => {
    const roomId = getMatrixRoomId(room) ?? room.id ?? room.key;
    if (!roomId) {
      setMessages([]);
      return;
    }
    setMessagesLoading(true);
    setMessages([]);
    try {
      const touchUser = String(room.attributes?.user ?? '');
      const res = await getRoomMessages({ limit: '50' }, { roomId, touchUser });
      const msgs = extractMessages(res);
      setMessages(msgs);
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setMessagesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (detailModal) {
      fetchMessages(detailModal);
    } else {
      setMessages([]);
    }
  }, [detailModal, fetchMessages]);

  const handleSearch = () => {
    setAppliedFilters({
      customer: customerFilter.trim(),
      advisor: advisorFilter.trim(),
      startDate,
      endDate,
    });
  };

  const filteredRooms = chatRooms.filter((r) => {
    const customer = refDisplay(r.attributes?.user).toLowerCase();
    const advisor = refDisplay(
      r.attributes?.advisorId ?? r.attributes?.advisor
    ).toLowerCase();
    const created = r.metadata?.createdAt ?? '';
    const updated = r.metadata?.updatedAt ?? '';
    const dateStr = updated || created;

    const customerMatch =
      !appliedFilters.customer ||
      customer.includes(appliedFilters.customer.toLowerCase());
    const advisorMatch =
      !appliedFilters.advisor ||
      advisor.includes(appliedFilters.advisor.toLowerCase());
    const dateMatch =
      (!appliedFilters.startDate || dateStr >= appliedFilters.startDate) &&
      (!appliedFilters.endDate || dateStr.slice(0, 10) <= appliedFilters.endDate);

    return customerMatch && advisorMatch && dateMatch;
  });

  const lastMessageDate = (room: ChatRoomInstance): string => {
    const updated = room.metadata?.updatedAt ?? room.metadata?.createdAt ?? '';
    return formatDateTime(updated);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Chat Yazışmaları</h1>
      </div>
      <div className="page-grid page-grid-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <MessageSquare size={20} />
              <h3>Chat Geçmişi</h3>
            </div>
          </CardHeader>
          <CardBody>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">TCKN / Müşteri No</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Müşteri ID veya TCKN"
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
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
              <button className="btn btn-primary" onClick={handleSearch}>
                <Search size={16} />
                Ara
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={fetchRooms}
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
            ) : filteredRooms.length === 0 ? (
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
                      <th>Son Mesaj Tarihi</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredRooms.map((r) => (
                      <tr
                        key={r.id ?? r.key}
                        className="card-hoverable"
                        style={{ cursor: 'pointer' }}
                        onClick={() => setDetailModal(r)}
                      >
                        <td>{refDisplay(r.attributes?.user)}</td>
                        <td>
                          <div className="flex items-center gap-2">
                            <User size={14} className="text-muted" />
                            {refDisplay(r.attributes?.advisorId ?? r.attributes?.advisor)}
                          </div>
                        </td>
                        <td>{getRoomTypeLabel(r.attributes?.roomType)}</td>
                        <td>
                          <Badge state={r.metadata?.currentState ?? ''} />
                        </td>
                        <td className="text-sm">{lastMessageDate(r)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Chat detail modal */}
      <Modal
        open={!!detailModal}
        onClose={() => setDetailModal(null)}
        title="Chat Detayı"
      >
        {detailModal && (
          <div className="flex flex-col gap-4">
            <div className="flex flex-col gap-2">
              <div className="flex items-center justify-between">
                <span className="form-label">Müşteri</span>
                <span>{refDisplay(detailModal.attributes?.user)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="form-label">Danışman</span>
                <span>
                  {refDisplay(
                    detailModal.attributes?.advisorId ?? detailModal.attributes?.advisor
                  )}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="form-label">Oda Tipi</span>
                <span>{getRoomTypeLabel(detailModal.attributes?.roomType)}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="form-label">Durum</span>
                <Badge state={detailModal.metadata?.currentState ?? ''} />
              </div>
              <div className="flex items-center justify-between">
                <span className="form-label">Oluşturulma Tarihi</span>
                <span className="text-sm">
                  {formatDateTime(detailModal.metadata?.createdAt)}
                </span>
              </div>
            </div>

            <div className="mt-4">
              <h4 className="form-label mb-2">Mesajlar</h4>
              {messagesLoading ? (
                <div className="empty-state">
                  <MessageSquare size={24} className="animate-spin" />
                  <p className="text-sm">Mesajlar yükleniyor...</p>
                </div>
              ) : messages.length === 0 ? (
                <p className="text-muted text-sm">Mesaj bulunamadı veya oda ID mevcut değil.</p>
              ) : (
                <div
                  className="flex flex-col gap-2 p-3 rounded-lg border border-[var(--color-border)] max-h-64 overflow-y-auto"
                  style={{ background: 'var(--color-bg)' }}
                >
                  {messages.map((m, i) => (
                    <div
                      key={m.eventId ?? i}
                      className="chat-msg theirs"
                      style={{ maxWidth: '100%' }}
                    >
                      <div className="text-xs text-muted mb-1">
                        {m.sender?.replace(/@|:.*/g, '') ?? '—'} •{' '}
                        {m.timestamp
                          ? formatTime(String(m.timestamp))
                          : '—'}
                      </div>
                      <div>{m.body ?? m.content ?? '—'}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
