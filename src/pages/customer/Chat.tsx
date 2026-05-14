import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import { MessageSquare, Send, Paperclip, Users } from 'lucide-react';
import { useLocation } from 'react-router-dom';
import {
  getChatRooms,
  getRoomMessages,
  sendRoomMessage,
  getMatrixSync,
  getInstance,
  listInstances,
} from '../../lib/api';
import { formatTime, formatDate, cn } from '../../lib/utils';
import { EmptyState, Modal, toast } from '../../components/ui';
import { useCustomerContext } from '../../contexts/CustomerContext';

type AdvisorWorkflow = 'portfolio-manager' | 'investment-advisor';

function workflowFromAdvisorType(advisorType?: string): AdvisorWorkflow | null {
  const t = (advisorType ?? '').trim().toUpperCase();
  if (t === 'PM') return 'portfolio-manager';
  if (t === 'IA') return 'investment-advisor';
  return null;
}

const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['.xlsx', '.docx', '.pdf', '.jpg', '.jpeg', '.png'];

// Matrix /sync long-poll back-off bounds.
// Synapse can return quickly when device_lists / one_time_keys streams advance
// (independent of our room filter), so we throttle the loop to avoid hammering
// the runtime. The minimum interval applies even on happy responses; the idle
// delay kicks in when the long-poll returned with no new room events.
const SYNC_MIN_INTERVAL_MS = 2000;
const SYNC_IDLE_DELAY_MS = 5000;
const SYNC_ERROR_DELAY_MS = 3000;

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
  failed?: boolean;
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
  const { customerId, customerName } = useCustomerContext();
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
  // Map advisor key (e.g. "U02917") -> human-readable name (e.g. "MERVE YILDIZ").
  // Populated lazily for every distinct advisorId across the customer's rooms
  // so the chat list / header / participants modal can hide the sicil number.
  const [advisorNames, setAdvisorNames] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const openAdvisorTriedRef = useRef(false);
  const syncTokenRef = useRef<string | null>(null);
  const syncAbortedRef = useRef(false);
  const inFlightRef = useRef(false);

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

  // Resolve advisor names for every advisor referenced by the active rooms so
  // the chat list / header / participants modal can show "MERVE YILDIZ" instead
  // of the raw sicil ("U02917"). Workflow is picked from advisorType (PM → portfolio-manager,
  // IA → investment-advisor) with a best-effort fallback when type is missing.
  useEffect(() => {
    if (rooms.length === 0) return;
    let cancelled = false;

    type Target = { key: string; workflow: AdvisorWorkflow };
    const seen = new Set<string>();
    const targets: Target[] = [];
    for (const r of rooms) {
      const id = r.attributes?.advisorId;
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const wf = workflowFromAdvisorType(r.attributes?.advisorType);
      if (wf) targets.push({ key: id, workflow: wf });
      else {
        targets.push({ key: id, workflow: 'portfolio-manager' });
        targets.push({ key: id, workflow: 'investment-advisor' });
      }
    }
    const missing = targets.filter((t) => !advisorNames[t.key]);
    if (missing.length === 0) return;

    const buildName = (attrs: Record<string, unknown> | undefined): string => {
      if (!attrs) return '';
      const first = String(attrs.firstName ?? '').trim();
      const last = String(attrs.lastName ?? '').trim();
      return `${first} ${last}`.trim();
    };

    const fetchByKey = async (key: string, workflow: AdvisorWorkflow): Promise<string> => {
      try {
        const res = await getInstance(workflow, key);
        if (res.ok && res.data) {
          const d = res.data as { attributes?: Record<string, unknown> };
          const name = buildName(d.attributes);
          if (name) return name;
        }
      } catch {
        /* fall back to list */
      }
      try {
        const list = await listInstances(workflow, { pageSize: 100 });
        if (list.ok && list.data) {
          const items = (list.data as { items?: { key?: string; attributes?: Record<string, unknown> }[] }).items ?? [];
          const match = items.find((i) => i.key === key);
          if (match) return buildName(match.attributes);
        }
      } catch {
        /* ignore */
      }
      return '';
    };

    (async () => {
      const resolved = await Promise.all(
        missing.map(async (t) => [t.key, await fetchByKey(t.key, t.workflow)] as const),
      );
      if (cancelled) return;
      const updates = resolved.filter(([, name]) => name.length > 0);
      if (updates.length === 0) return;
      setAdvisorNames((prev) => {
        const next = { ...prev };
        for (const [k, name] of updates) {
          if (!next[k]) next[k] = name;
        }
        return next;
      });
    })();

    return () => {
      cancelled = true;
    };
  }, [rooms, advisorNames]);

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
      const startedAt = Date.now();
      let hadRoomEvents = false;
      let errored = false;
      try {
        const params: { user: string; timeout: string; roomId: string; since?: string } = {
          user: customerId,
          timeout: syncTokenRef.current ? '30000' : '0',
          roomId: matrixRoomId,
        };
        if (syncTokenRef.current) params.since = syncTokenRef.current;

        const res = await getMatrixSync(params);
        if (syncAbortedRef.current) return;
        const syncData = extractSyncResponse(res);
        if (syncData) {
          if (syncData.nextBatch) syncTokenRef.current = syncData.nextBatch;
          const roomEvents = syncData.eventsByRoom?.[matrixRoomId];
          if (Array.isArray(roomEvents) && roomEvents.length > 0) {
            setMessages((prev) => mergeNewMessages(prev, roomEvents, customerId));
            hadRoomEvents = true;
          }
        } else {
          errored = true;
        }
      } catch {
        errored = true;
      }
      if (syncAbortedRef.current) return;
      // Throttle: even if Synapse returns instantly (device_lists noise), keep at
      // least SYNC_MIN_INTERVAL_MS between requests. Add extra idle / error delay
      // when there is nothing new to merge so we are not polling 5×/sec.
      const elapsed = Date.now() - startedAt;
      let minDelay = SYNC_MIN_INTERVAL_MS;
      if (errored) minDelay = Math.max(minDelay, SYNC_ERROR_DELAY_MS);
      else if (!hadRoomEvents) minDelay = Math.max(minDelay, SYNC_IDLE_DELAY_MS);
      const delay = Math.max(0, minDelay - elapsed);
      setTimeout(runSyncLoop, delay);
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
    if (inFlightRef.current) return;
    const matrixRoomId = getMatrixRoomId(selectedRoom);
    if (!matrixRoomId) {
      toast('Oda bilgisi bulunamadı.', 'error');
      return;
    }

    inFlightRef.current = true;
    setSending(true);

    const tempId = `${PENDING_PREFIX}${Date.now()}`;
    setMessages((prev) => [
      ...prev,
      {
        eventId: tempId,
        body: text,
        sender: `@${customerId}:localhost`,
        timestamp: Date.now(),
        isMine: true,
        read: false,
        failed: false,
      },
    ]);
    setInputText('');

    try {
      const res = await sendRoomMessage(matrixRoomId, customerId, text);
      if (!res.ok) throw new Error(`HTTP ${res.status || 'error'}`);
    } catch (e) {
      setMessages((prev) =>
        prev.map((m) => (m.eventId === tempId ? { ...m, failed: true } : m))
      );
      toast(e instanceof Error ? e.message : String(e) || 'Mesaj gönderilemedi', 'error');
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
  };

  /** Matrix `@localpart:server` formatından kullanıcı dostu isim üret.
   * Sıra: localpart customer mı (TCKN ile direkt veya "u" prefix) → customerName;
   * advisorNames map'inde (case-insensitive) eşleşme var mı → o isim;
   * yoksa son çare olarak "Danışman" — sicil/TCKN ekrana hiç çıkmaz. */
  const renderSenderName = useCallback(
    (sender?: string): string => {
      const localpart = (sender ?? '').replace(/@|:.*/g, '').trim();
      if (!localpart) return 'Danışman';
      const lower = localpart.toLowerCase();
      const cidLower = (customerId ?? '').toLowerCase();
      if (cidLower && (lower === cidLower || lower === `u${cidLower}`)) {
        return customerName ?? customerId ?? 'Müşteri';
      }
      const matchKey = Object.keys(advisorNames).find((k) => {
        const kl = k.toLowerCase();
        return kl === lower || `u${kl}` === lower || kl === `u${lower}`;
      });
      if (matchKey) return advisorNames[matchKey];
      return 'Danışman';
    },
    [advisorNames, customerId, customerName],
  );

  const retryFailedMessage = (msg: ChatMessage) => {
    if (!msg.body) return;
    setMessages((prev) => prev.filter((m) => m.eventId !== msg.eventId));
    setInputText(msg.body);
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
                const advisorId = room.attributes?.advisorId ?? '';
                const advisorType = room.attributes?.advisorType ?? '';
                // Sicil numarası yerine isim soyisim: advisorNames map'inden çek; yoksa
                // resolve tamamlanana dek geçici olarak danışman tipi etiketini göster
                // (TCKN/sicil hiçbir koşulda görünmesin).
                const advisorDisplayName = advisorId ? advisorNames[advisorId] : '';
                const advisorTypeLabel = advisorType === 'PM'
                  ? 'Portföy Yöneticisi'
                  : advisorType === 'IA'
                    ? 'Yatırım Danışmanı'
                    : '';
                const advisorLabel = advisorDisplayName || advisorTypeLabel || 'Danışman';
                const displayChar = (advisorDisplayName || advisorTypeLabel || advisorType || '?')
                  .charAt(0)
                  .toUpperCase();
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
                      <div className="chat-item-name">{advisorLabel}</div>
                      <div className="chat-item-preview">
                        {advisorTypeLabel || `${room.attributes?.members?.length ?? 0} kişi`}
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
                    {(() => {
                      const aid = selectedRoom.attributes?.advisorId ?? '';
                      const at = selectedRoom.attributes?.advisorType ?? '';
                      const name = aid ? advisorNames[aid] : '';
                      const typeLabel = at === 'PM'
                        ? 'Portföy Yöneticisi'
                        : at === 'IA'
                          ? 'Yatırım Danışmanı'
                          : '';
                      return name || typeLabel || 'Sohbet';
                    })()}
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
                        <div
                          key={m.eventId ?? i}
                          className={cn('chat-msg', m.isMine ? 'mine' : 'theirs', m.failed && 'failed')}
                        >
                          {!m.isMine && (
                            <div className="chat-msg-sender">
                              {renderSenderName(m.sender)}
                            </div>
                          )}
                          <div className="chat-msg-body">{m.body ?? m.content ?? ''}</div>
                          <div className="chat-msg-meta">
                            {formatTime(m.timestamp)}
                            {m.failed && (
                              <>
                                {' · '}
                                <button
                                  type="button"
                                  onClick={() => retryFailedMessage(m)}
                                  style={{
                                    background: 'none',
                                    border: 'none',
                                    color: 'var(--color-danger, #c00)',
                                    padding: 0,
                                    cursor: 'pointer',
                                    textDecoration: 'underline',
                                    font: 'inherit',
                                  }}
                                >
                                  Gönderilemedi — tekrar dene
                                </button>
                              </>
                            )}
                          </div>
                        </div>
                      ))}
                    </Fragment>
                  ))
                )}
                <div ref={messagesEndRef} />
              </div>

              <form
                className="chat-input-area"
                onSubmit={(e) => {
                  e.preventDefault();
                  handleSend();
                }}
              >
                <input
                  ref={fileInputRef}
                  type="file"
                  accept={ALLOWED_EXTENSIONS.join(',')}
                  style={{ display: 'none' }}
                  onChange={handleFileSelect}
                />
                <button
                  type="button"
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
                  disabled={!getMatrixRoomId(selectedRoom)}
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={sending || !inputText.trim() || !getMatrixRoomId(selectedRoom)}
                >
                  <Send size={14} />
                  Gönder
                </button>
              </form>
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
            // Sicil (advisor) veya TCKN (customer) yerine ekrana isim soyisim yansıt:
            // owner ise CustomerContext'teki customerName; advisor ise advisorNames map.
            const displayName = role === 'owner'
              ? (customerName ?? mid)
              : (advisorNames[mid] ?? mid);
            return (
              <li
                key={mid}
                className="flex items-center justify-between"
                style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
              >
                <span>{displayName}</span>
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
