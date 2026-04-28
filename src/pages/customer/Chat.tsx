import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { MessageSquare, Send, Paperclip, Users } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import { getChatRooms, getRoomMessages, sendRoomMessage, getMatrixSync } from '../../lib/api';
import { formatTime, formatDate, cn } from '../../lib/utils';
import { EmptyState, Modal, toast } from '../../components/ui';
import { useCustomerContext } from '../../contexts/CustomerContext';

const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['.xlsx', '.docx', '.pdf', '.jpg', '.jpeg', '.png'];

interface ChatRoomMember {
  memberId?: string;
  role?: string;
}

interface ChatRoomInstance {
  key: string;
  id?: string;
  attributes: {
    advisorId?: string;
    advisorType?: string;
    roomType?: string;
    chatIntegration?: { matrix?: { roomId?: string } };
    members?: ChatRoomMember[];
  };
  metadata?: { currentState?: string };
}

interface ChatMessage {
  eventId?: string;
  sender?: string;
  body?: string;
  content?: string;
  timestamp?: string | number;
  msgtype?: string;
  isMine?: boolean;
  read?: boolean;
}

/** Backend can return flat rooms (instanceKey, advisorId, roomType, roomId) or nested (key, attributes). */
function normalizeRoom(raw: Record<string, unknown>): ChatRoomInstance {
  const key = (raw.key as string) ?? (raw.instanceKey as string) ?? '';
  const attrs = (raw.attributes as Record<string, unknown>) ?? {};
  const rawMembers = (raw.members ?? attrs.members) as ChatRoomMember[] | undefined;
  const members = Array.isArray(rawMembers) ? rawMembers : undefined;
  return {
    key,
    id: raw.id as string | undefined,
    attributes: {
      advisorId: (raw.advisorId as string) ?? (attrs.advisorId as string),
      advisorType: (raw.advisorType as string) ?? (attrs.advisorType as string),
      roomType: (raw.roomType as string) ?? (attrs.roomType as string),
      chatIntegration: (raw.roomId as string)
        ? { matrix: { roomId: raw.roomId as string } }
        : (attrs.chatIntegration as { matrix?: { roomId?: string } } | undefined),
      members,
    },
    metadata: (raw.metadata as ChatRoomInstance['metadata']) ?? undefined,
  };
}

function extractRooms(res: { ok: boolean; data?: unknown }): ChatRoomInstance[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;

  // Paginated response: items = [ { getChatRooms: { rooms: [...] } } ] — extract rooms from first (or all) pages
  const topItems = d?.items as Array<{ getChatRooms?: { rooms?: unknown[] } }> | undefined;
  if (Array.isArray(topItems) && topItems.length > 0) {
    const roomsFromItems = topItems.flatMap((it) => it?.getChatRooms?.rooms ?? []);
    if (roomsFromItems.length > 0) {
      const items = roomsFromItems.filter((r): r is Record<string, unknown> => typeof r === 'object' && r != null);
      return items.map((item) => normalizeRoom(item));
    }
  }

  // Direct: Data.rooms / data.rooms or getChatRooms.rooms / .items
  const data = (d?.Data ?? d?.data) as { rooms?: unknown[]; items?: unknown[] } | undefined;
  const gc = d?.getChatRooms as { items?: unknown[]; rooms?: unknown[] } | undefined;
  const rawList =
    data?.rooms ??
    data?.items ??
    gc?.rooms ??
    gc?.items ??
    [];
  const items = Array.isArray(rawList) ? rawList : [];
  return items.map((item) => normalizeRoom(typeof item === 'object' && item != null ? (item as Record<string, unknown>) : {}));
}

function extractMessages(res: { ok: boolean; data?: unknown }): ChatMessage[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;

  // Paginated response: items = [ { getRoomMessages: { messages: [...] } } ]
  const topItems = d?.items as Array<{ getRoomMessages?: { messages?: ChatMessage[] } }> | undefined;
  if (Array.isArray(topItems) && topItems.length > 0) {
    const msgs = topItems.flatMap((it) => it?.getRoomMessages?.messages ?? []);
    if (msgs.length > 0) return msgs;
  }

  // Fallback: d.getRoomMessages.messages or d.messages
  const nested = d.getRoomMessages as { messages?: ChatMessage[] } | undefined;
  const messages = (d.messages as ChatMessage[] | undefined) ?? nested?.messages ?? [];
  return Array.isArray(messages) ? messages : [];
}

function getMatrixRoomId(room: ChatRoomInstance): string | null {
  const ci = room.attributes?.chatIntegration as { matrix?: { roomId?: string }; roomId?: string } | undefined;
  return ci?.matrix?.roomId ?? ci?.roomId ?? null;
}

interface SyncResponse {
  nextBatch: string | null;
  eventsByRoom: Record<string, Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>>;
}

function extractSyncResponse(res: { ok: boolean; data?: unknown }): SyncResponse | null {
  if (!res.ok || !res.data) return null;
  const d = res.data as Record<string, unknown>;
  const topItems = d?.items as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(topItems) && topItems.length > 0) {
    const first = topItems[0];
    const sync =
      (first?.getMatrixSync as SyncResponse) ??
      (first?.['get-matrix-sync-success'] as SyncResponse) ??
      (first?.['get-matrix-sync'] as SyncResponse);
    if (sync && (sync.nextBatch != null || sync.eventsByRoom)) return sync;
  }
  const direct = (d.getMatrixSync ?? d['get-matrix-sync-success']) as SyncResponse | undefined;
  return direct ?? null;
}

const PENDING_PREFIX = 'pending-';

function mergeNewMessages(
  prev: ChatMessage[],
  newMsgs: Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>,
  customerId: string
): ChatMessage[] {
  const customerMatrixId = `@${customerId}:localhost`;
  const existingIds = new Set(prev.map((m) => m.eventId).filter(Boolean));
  const toAdd = newMsgs
    .filter((m) => m.eventId && !existingIds.has(m.eventId))
    .map((m) => ({
      ...m,
      isMine: (m.sender ?? '').includes(customerId) || (m.sender ?? '') === customerMatrixId,
      read: false,
    }));
  if (toAdd.length === 0) return prev;

  const fromUs = toAdd.filter((m) => (m.sender ?? '').includes(customerId) || (m.sender ?? '') === customerMatrixId);
  const withoutOptimistic = fromUs.length > 0
    ? prev.filter((m) => {
        if (m.eventId?.startsWith(PENDING_PREFIX) && m.isMine) {
          return !fromUs.some((n) => n.body === m.body);
        }
        return true;
      })
    : prev;

  return [...withoutOptimistic, ...toAdd].sort((a, b) => {
    const ta = Number(a.timestamp) || 0;
    const tb = Number(b.timestamp) || 0;
    return ta - tb;
  });
}

function groupMessagesByDate(msgs: ChatMessage[]): Record<string, ChatMessage[]> {
  const grouped: Record<string, ChatMessage[]> = {};
  for (const m of msgs) {
    const ts = m.timestamp;
    const key =
      ts != null && ts !== ''
        ? formatDate(typeof ts === 'number' ? ts : Number(ts))
        : '—';
    if (key && key !== '—') {
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(m);
    } else {
      const fallback = 'Diğer';
      if (!grouped[fallback]) grouped[fallback] = [];
      grouped[fallback].push(m);
    }
  }
  return grouped;
}

function validateFile(file: File): string | null {
  const ext = '.' + file.name.split('.').pop()?.toLowerCase();
  if (!ALLOWED_EXTENSIONS.includes(ext)) {
    return `Sadece ${ALLOWED_EXTENSIONS.join(', ')} kabul edilir.`;
  }
  if (file.size > MAX_FILE_SIZE_MB * 1024 * 1024) {
    return `Dosya en fazla ${MAX_FILE_SIZE_MB}MB olabilir.`;
  }
  return null;
}

export function Chat() {
  const { customerId } = useCustomerContext();
  const location = useLocation();
  const openAdvisorKey = (location.state as { openAdvisorKey?: string } | null)?.openAdvisorKey;

  const [rooms, setRooms] = useState<ChatRoomInstance[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoomInstance | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [participantsModal, setParticipantsModal] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAdvisorTriedRef = useRef(false);
  const syncTokenRef = useRef<string | null>(null);
  const syncAbortedRef = useRef(false);
  const lastSendRef = useRef<{ body: string; at: number } | null>(null);

  const fetchRooms = useCallback(async () => {
    if (!customerId) return;
    setLoading(true);
    try {
      const res = await getChatRooms({ touchUser: customerId, userType: 'customer' });
      const list = extractRooms(res);
      const active = list.filter((r) => {
        const st = r.metadata?.currentState;
        return st !== 'deactivated' && st !== 'failed';
      });
      setRooms(active);
      return active;
    } catch (e) {
      toast(String(e), 'error');
      return [];
    } finally {
      setLoading(false);
    }
  }, [customerId]);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  useEffect(() => {
    if (!openAdvisorKey || rooms.length === 0) return;
    const match = rooms.find(
      (r) =>
        r.attributes?.advisorId === openAdvisorKey ||
        (r.attributes?.advisorId && openAdvisorKey.includes(r.attributes.advisorId)) ||
        (r.key != null && r.key.includes(openAdvisorKey))
    );
    if (match) {
      setSelectedRoom(match);
    } else if (!openAdvisorTriedRef.current) {
      openAdvisorTriedRef.current = true;
      const t = window.setTimeout(() => {
        fetchRooms().then((active) => {
          const retryMatch = active?.find(
            (r) =>
              r.attributes?.advisorId === openAdvisorKey ||
              (r.key != null && r.key.includes(openAdvisorKey))
          );
          if (retryMatch) setSelectedRoom(retryMatch);
        });
      }, 1500);
      return () => clearTimeout(t);
    }
  }, [openAdvisorKey, rooms, fetchRooms]);

  const fetchMessages = useCallback(
    async (room: ChatRoomInstance) => {
      const matrixRoomId = getMatrixRoomId(room);
      setMessagesLoading(true);
      setMessages([]);
      try {
        let msgs: ChatMessage[] = [];
        if (matrixRoomId && customerId) {
          const res = await getRoomMessages(
            { limit: '50', pageSize: '1' },
            { roomId: matrixRoomId, touchUser: customerId }
          );
          const apiMsgs = extractMessages(res);
          const customerMatrixId = `@${customerId}:localhost`;
          msgs = [...apiMsgs].reverse().map((m) => ({
            ...m,
            isMine: (m.sender ?? '').includes(customerId) || (m.sender ?? '') === customerMatrixId,
            read: false,
          }));
        }
        setMessages(msgs);
      } catch (e) {
        toast(String(e), 'error');
      } finally {
        setMessagesLoading(false);
      }
    },
    [customerId]
  );

  useEffect(() => {
    if (selectedRoom) fetchMessages(selectedRoom);
  }, [selectedRoom?.key, fetchMessages]);

  useEffect(() => {
    if (!selectedRoom || !customerId) return;
    const matrixRoomId = getMatrixRoomId(selectedRoom);
    if (!matrixRoomId) return;

    syncAbortedRef.current = false;
    syncTokenRef.current = null;

    const runSyncLoop = async () => {
      if (syncAbortedRef.current) return;
      try {
        const params: { user: string; timeout: string; roomId: string; since?: string } = {
          user: customerId,
          timeout: syncTokenRef.current ? '30000' : '0',
          roomId: matrixRoomId,
        };
        if (syncTokenRef.current) params.since = syncTokenRef.current;

        const res = await getMatrixSync(params);
        const syncData = extractSyncResponse(res);
        if (!syncData || syncAbortedRef.current) return;

        if (syncData.nextBatch) syncTokenRef.current = syncData.nextBatch;

        const roomEvents = syncData.eventsByRoom?.[matrixRoomId];
        if (Array.isArray(roomEvents) && roomEvents.length > 0) {
          setMessages((prev) => mergeNewMessages(prev, roomEvents, customerId));
        }
      } catch {
        // Will retry on next loop
      }
      if (!syncAbortedRef.current) {
        setTimeout(runSyncLoop, 0);
      }
    };

    runSyncLoop();
    return () => {
      syncAbortedRef.current = true;
    };
  }, [selectedRoom?.key, customerId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !selectedRoom || !customerId) return;
    if (sending) return;
    const matrixRoomId = getMatrixRoomId(selectedRoom);
    if (!matrixRoomId) {
      toast('Oda bilgisi bulunamadı.', 'error');
      return;
    }
    if (lastSendRef.current && lastSendRef.current.body === text && Date.now() - lastSendRef.current.at < 2000) {
      return;
    }
    lastSendRef.current = { body: text, at: Date.now() };
    setSending(true);
    try {
      await sendRoomMessage(matrixRoomId, customerId, text);
      setInputText('');
      setMessages((prev) => [
        ...prev,
        {
          eventId: `${PENDING_PREFIX}${Date.now()}`,
          body: text,
          sender: `@${customerId}:localhost`,
          timestamp: Date.now(),
          isMine: true,
          read: false,
        },
      ]);
    } catch (e) {
      toast(String(e) || 'Mesaj gönderilemedi', 'error');
    } finally {
      setSending(false);
    }
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file || !selectedRoom) return;
    const err = validateFile(file);
    if (err) {
      toast(err, 'error');
      return;
    }
    toast('Dosya gönderimi henüz desteklenmiyor.', 'error');
    e.target.value = '';
  };

  if (!customerId) {
    return (
      <div className="page">
        <div className="empty-state">
          <p>Oturum bilgisi yok.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="page">
      <div className="page-header">
        <h1>Sohbet</h1>
      </div>

      <div className="chat-layout">
        <div className="chat-list">
          <div className="chat-list-items">
            {loading ? (
              <div className="empty-state">
                <MessageSquare size={32} className="animate-spin" />
                <p>Yükleniyor...</p>
              </div>
            ) : rooms.length === 0 ? (
              <EmptyState message="Henüz sohbet yok. Dashboard'dan Mesaj ile başlatın." />
            ) : (
              rooms.map((room, index) => {
                const isActive = selectedRoom?.key === room.key;
                const advisorId = room.attributes?.advisorId ?? room.key ?? '';
                const advisorType = room.attributes?.advisorType ?? '';
                const displayChar = (advisorId || advisorType || '?').charAt(0).toUpperCase();
                return (
                  <div
                    key={room.key ?? room.id ?? `room-${index}`}
                    className={cn('chat-list-item', isActive && 'active')}
                    onClick={() => setSelectedRoom(room)}
                  >
                    <div className="chat-item-avatar">
                      <span style={{ fontSize: 14 }}>{displayChar}</span>
                    </div>
                    <div className="chat-item-info">
                      <div className="chat-item-name">{advisorId || '—'}</div>
                      <div className="chat-item-preview">
                        {(room.attributes?.members?.length ?? 0)} kişi
                      </div>
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>

        <div className="chat-panel">
          {selectedRoom ? (
            <>
              <div className="chat-panel-header">
                <div className="flex items-center gap-3">
                  <h3 style={{ fontSize: 15, fontWeight: 600 }}>
                    {selectedRoom.attributes?.advisorId || selectedRoom.key || 'Sohbet'}
                  </h3>
                  <span className="badge badge-sm" style={{ '--badge-color': 'var(--color-muted)' } as React.CSSProperties}>
                    {selectedRoom.attributes?.roomType === 'permanent' ? 'Kalıcı' : selectedRoom.attributes?.roomType === 'rezervation' ? 'Randevu' : 'Sohbet'}
                  </span>
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setParticipantsModal(true)}
                    title="Katılımcılar"
                  >
                    <Users size={14} />
                    Katılımcılar
                  </button>
                </div>
              </div>

              <div className="chat-messages">
                {messagesLoading ? (
                  <div className="empty-state">
                    <MessageSquare size={32} className="animate-spin" />
                    <p>Mesajlar yükleniyor...</p>
                  </div>
                ) : messages.length === 0 ? (
                  <EmptyState message="Henüz mesaj yok" />
                ) : (
                  Object.entries(groupMessagesByDate(messages)).map(([date, msgs]) => (
                    <Fragment key={date}>
                      <div className="chat-date-divider">{date}</div>
                      {msgs.map((m, i) => (
                        <div key={m.eventId ?? i} className={cn('chat-msg', m.isMine ? 'mine' : 'theirs')}>
                          {!m.isMine && (
                            <div className="chat-msg-sender">
                              {m.sender?.replace(/@|:.*/g, '') || 'Danışman'}
                            </div>
                          )}
                          <div className="chat-msg-body">{m.body ?? m.content ?? ''}</div>
                          <div className="chat-msg-meta">{formatTime(m.timestamp)}</div>
                        </div>
                      ))}
                    </Fragment>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <div className="chat-input-area">
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ALLOWED_EXTENSIONS.join(',')}
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                <button
                  className="btn-icon"
                  onClick={() => fileInputRef.current?.click()}
                  title="Dosya ekle"
                  disabled={sending}
                >
                  <Paperclip size={18} />
                </button>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Mesaj yazın..."
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSend}
                  disabled={sending || !inputText.trim()}
                >
                  <Send size={14} />
                  Gönder
                </button>
              </div>
            </>
          ) : (
            <div className="empty-state" style={{ flex: 1 }}>
              <MessageSquare size={48} strokeWidth={1.5} />
              <p>Bir sohbet seçin</p>
            </div>
          )}
        </div>
      </div>

      <Modal
        open={participantsModal}
        onClose={() => setParticipantsModal(false)}
        title="Katılımcılar"
        footer={
          <button className="btn btn-primary" onClick={() => setParticipantsModal(false)}>
            Kapat
          </button>
        }
      >
        <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
          {(selectedRoom?.attributes?.members ?? []).map((m) => {
            const mid = (m.memberId ?? '').trim();
            const role = (m.role ?? '').trim();
            const roleLabel = role === 'owner' ? 'Müşteri' : role === 'advisor' ? 'Asıl Danışman' : 'Üye';
            return (
              <li
                key={mid}
                className="flex items-center justify-between"
                style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
              >
                <span>{mid}</span>
                <span className="badge badge-sm" style={{ '--badge-color': 'var(--color-muted)' } as React.CSSProperties}>
                  {roleLabel}
                </span>
              </li>
            );
          })}
        </ul>
      </Modal>
    </div>
  );
}
