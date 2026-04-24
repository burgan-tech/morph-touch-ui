import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import {
  Star,
  Send,
  Paperclip,
  ChevronDown,
  UserPlus,
  Users,
  MessageSquare,
} from 'lucide-react';
import { getChatRooms, getRoomMessages, sendRoomMessage, getMatrixSync, runTransition, listInstances } from '../../lib/api';
import { formatTime, formatDate, cn } from '../../lib/utils';
import { EmptyState, Modal, toast } from '../../components/ui';
import { useAdvisorContext } from '../../contexts/AdvisorContext';
import { HISTORY_VISIBILITY_OPTIONS, type MatrixHistoryVisibility } from '../../lib/matrixChat';

const FAVORITES_KEY = 'chat-favorites';
const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['.xlsx', '.docx', '.pdf', '.jpg', '.jpeg', '.png'];

/* ── types ── */

interface ChatRoomMember {
  memberId?: string;
  role?: string;
}

interface ChatRoomInstance {
  key: string;
  id?: string;
  attributes: {
    user?: string | { key?: string };
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

/* ── extraction helpers (identical to customer Chat.tsx) ── */

function normalizeRoom(raw: Record<string, unknown>): ChatRoomInstance {
  const key = (raw.key as string) ?? (raw.instanceKey as string) ?? '';
  const attrs = (raw.attributes as Record<string, unknown>) ?? {};
  const rawMembers = (raw.members ?? attrs.members) as ChatRoomMember[] | undefined;
  const members = Array.isArray(rawMembers) ? rawMembers : undefined;
  return {
    key,
    id: raw.id as string | undefined,
    attributes: {
      user: (raw.user as string) ?? (attrs.user as string | { key?: string }),
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

  const topItems = d?.items as Array<{ getChatRooms?: { rooms?: unknown[] } }> | undefined;
  if (Array.isArray(topItems) && topItems.length > 0) {
    const roomsFromItems = topItems.flatMap((it) => it?.getChatRooms?.rooms ?? []);
    if (roomsFromItems.length > 0) {
      const items = roomsFromItems.filter((r): r is Record<string, unknown> => typeof r === 'object' && r != null);
      return items.map((item) => normalizeRoom(item));
    }
  }

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

  const topItems = d?.items as Array<{ getRoomMessages?: { messages?: ChatMessage[] } }> | undefined;
  if (Array.isArray(topItems) && topItems.length > 0) {
    const msgs = topItems.flatMap((it) => it?.getRoomMessages?.messages ?? []);
    if (msgs.length > 0) return msgs;
  }

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

/* ── advisor-specific helpers ── */

function userName(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function loadFavorites(): Set<string> {
  try {
    const raw = localStorage.getItem(FAVORITES_KEY);
    const arr = raw ? (JSON.parse(raw) as string[]) : [];
    return new Set(arr);
  } catch {
    return new Set();
  }
}

function saveFavorites(fav: Set<string>) {
  localStorage.setItem(FAVORITES_KEY, JSON.stringify([...fav]));
}

const PENDING_PREFIX = 'pending-';

function mergeNewMessages(
  prev: ChatMessage[],
  newMsgs: Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>,
  advisorId: string
): ChatMessage[] {
  const advisorMatrixId = `@${advisorId}:localhost`;
  const existingIds = new Set(prev.map((m) => m.eventId).filter(Boolean));
  const toAdd = newMsgs
    .filter((m) => m.eventId && !existingIds.has(m.eventId))
    .map((m) => ({
      ...m,
      isMine: (m.sender ?? '').includes(advisorId) || (m.sender ?? '') === advisorMatrixId,
      read: false,
    }));
  if (toAdd.length === 0) return prev;

  const fromUs = toAdd.filter((m) => (m.sender ?? '').includes(advisorId) || (m.sender ?? '') === advisorMatrixId);
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

/* ── component ── */

export function ChatManagement() {
  const ADVISOR_ID = useAdvisorContext().advisorId!;
  const [rooms, setRooms] = useState<ChatRoomInstance[]>([]);
  const [selectedRoom, setSelectedRoom] = useState<ChatRoomInstance | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [search, setSearch] = useState('');
  const [showFavoritesOnly, setShowFavoritesOnly] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const [favorites, setFavorites] = useState<Set<string>>(loadFavorites);
  const [transferModal, setTransferModal] = useState(false);
  const [participantsModal, setParticipantsModal] = useState(false);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [statusTransitionLoading, setStatusTransitionLoading] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [unreadRooms, setUnreadRooms] = useState<Set<string>>(new Set());
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const syncTokenRef = useRef<string | null>(null);
  const syncAbortedRef = useRef(false);
  const lastSendRef = useRef<{ body: string; at: number } | null>(null);

  /* ── fetch rooms (same as customer, advisor param instead of user) ── */

  const fetchRooms = useCallback(async (): Promise<ChatRoomInstance[]> => {
    setLoading(true);
    try {
      const res = await getChatRooms({ pageSize: '1' }, { touchUser: ADVISOR_ID, userType: 'advisor' });
      const list = extractRooms(res);
      const filtered = list.filter((r) => (r.metadata?.currentState ?? '') !== 'failed');
      setRooms(filtered);
      return filtered;
    } catch (e) {
      toast(String(e), 'error');
      return [];
    } finally {
      setLoading(false);
    }
  }, [ADVISOR_ID]);

  useEffect(() => {
    fetchRooms();
  }, [fetchRooms]);

  /* ── fetch messages (identical to customer) ── */

  const fetchMessages = useCallback(
    async (room: ChatRoomInstance) => {
      const matrixRoomId = getMatrixRoomId(room);
      setMessagesLoading(true);
      setMessages([]);
      try {
        let msgs: ChatMessage[] = [];
        if (matrixRoomId) {
          const res = await getRoomMessages(
            { limit: '50', pageSize: '1' },
            { roomId: matrixRoomId, touchUser: ADVISOR_ID }
          );
          const apiMsgs = extractMessages(res);
          const advisorMatrixId = `@${ADVISOR_ID}:localhost`;
          msgs = [...apiMsgs].reverse().map((m) => ({
            ...m,
            isMine: (m.sender ?? '').includes(ADVISOR_ID) || (m.sender ?? '') === advisorMatrixId,
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
    [ADVISOR_ID]
  );

  useEffect(() => {
    if (selectedRoom) fetchMessages(selectedRoom);
  }, [selectedRoom?.key, fetchMessages]);

  /* ── real-time sync (identical to customer) ── */

  useEffect(() => {
    if (!selectedRoom) return;
    const matrixRoomId = getMatrixRoomId(selectedRoom);
    if (!matrixRoomId) return;

    syncAbortedRef.current = false;
    syncTokenRef.current = null;

    const runSyncLoop = async () => {
      if (syncAbortedRef.current) return;
      try {
        const params: { user: string; timeout: string; roomId: string; since?: string } = {
          user: ADVISOR_ID,
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
          setMessages((prev) => mergeNewMessages(prev, roomEvents, ADVISOR_ID));
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
  }, [selectedRoom?.key, ADVISOR_ID]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  useEffect(() => {
    if (!statusDropdownOpen) return;
    const onDocClick = (e: MouseEvent) => {
      if (statusDropdownRef.current && !statusDropdownRef.current.contains(e.target as Node)) {
        setStatusDropdownOpen(false);
      }
    };
    document.addEventListener('click', onDocClick);
    return () => document.removeEventListener('click', onDocClick);
  }, [statusDropdownOpen]);

  /* ── send message (identical to customer) ── */

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !selectedRoom) return;
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
      await sendRoomMessage(matrixRoomId, ADVISOR_ID, text);
      setInputText('');
      setMessages((prev) => [
        ...prev,
        {
          eventId: `${PENDING_PREFIX}${Date.now()}`,
          body: text,
          sender: `@${ADVISOR_ID}:localhost`,
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

  /* ── advisor-only: transfer & close ── */

  const handleTransfer = async () => {
    const instanceId = selectedRoom?.id ?? selectedRoom?.key;
    if (!instanceId || !transferTargetId.trim()) return;
    try {
      const res = await runTransition('chat-room', instanceId, 'transfer', {
        attributes: { newAdvisorId: transferTargetId.trim() },
      });
      if (res.ok) {
        toast('Chat başarıyla devredildi', 'success');
        setTransferModal(false);
        setTransferTargetId('');
        setSelectedRoom(null);
        fetchRooms();
      } else {
        toast('Transfer başarısız: ' + (res.data as { error?: string })?.error, 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const handleDeactivate = async () => {
    const instanceId = selectedRoom?.id ?? selectedRoom?.key;
    const roomKey = selectedRoom?.key;
    if (!instanceId) return;
    setStatusTransitionLoading(true);
    setStatusDropdownOpen(false);
    try {
      const res = await runTransition('chat-room', instanceId, 'deactivate');
      if (res.ok) {
        toast('Görüşme pasife alındı', 'success');
        const list = await fetchRooms();
        const updated = list.find((r) => (r.id ?? r.key) === instanceId || r.key === roomKey);
        if (updated) setSelectedRoom(updated);
      } else {
        toast('Pasife alma başarısız', 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setStatusTransitionLoading(false);
    }
  };

  const handleActivate = async () => {
    const instanceId = selectedRoom?.id ?? selectedRoom?.key;
    const roomKey = selectedRoom?.key;
    if (!instanceId) return;
    setStatusTransitionLoading(true);
    setStatusDropdownOpen(false);
    try {
      const res = await runTransition('chat-room', instanceId, 'activate');
      if (res.ok) {
        toast('Görüşme aktife alındı', 'success');
        const list = await fetchRooms();
        const updated = list.find((r) => (r.id ?? r.key) === instanceId || r.key === roomKey);
        if (updated) setSelectedRoom(updated);
      } else {
        toast('Aktife alma başarısız', 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setStatusTransitionLoading(false);
    }
  };

  /* ── participants modal ── */

  const [availableAdvisors, setAvailableAdvisors] = useState<Array<{ key: string; name: string; type: string }>>([]);
  const [addParticipantId, setAddParticipantId] = useState('');
  const [addParticipantHistoryVisibility, setAddParticipantHistoryVisibility] =
    useState<MatrixHistoryVisibility>('shared');
  const [participantsLoading, setParticipantsLoading] = useState(false);

  useEffect(() => {
    if (!participantsModal || !selectedRoom) return;
    const loadAdvisors = async () => {
      setParticipantsLoading(true);
      try {
        const [pmRes, iaRes] = await Promise.all([
          listInstances('portfolio-manager', { pageSize: 100 }),
          listInstances('investment-advisor', { pageSize: 100 }),
        ]);
        const pmItems = (pmRes.ok && (pmRes.data as { items?: Array<{ key: string; attributes?: Record<string, unknown> }> })?.items) ?? [];
        const iaItems = (iaRes.ok && (iaRes.data as { items?: Array<{ key: string; attributes?: Record<string, unknown> }> })?.items) ?? [];
        const buildName = (inst: { key: string; attributes?: Record<string, unknown> }) => {
          const a = inst.attributes ?? {};
          const first = (a.firstName ?? a.name ?? '') as string;
          const last = (a.lastName ?? a.surname ?? '') as string;
          return (first || last) ? `${first} ${last}`.trim() : inst.key;
        };
        const all = [
          ...pmItems.map((i) => ({ key: i.key, name: buildName(i), type: 'PM' })),
          ...iaItems.map((i) => ({ key: i.key, name: buildName(i), type: 'IA' })),
        ].sort((a, b) => a.name.localeCompare(b.name, 'tr'));
        setAvailableAdvisors(all);
      } catch {
        toast('Danışman listesi yüklenemedi', 'error');
      } finally {
        setParticipantsLoading(false);
      }
    };
    loadAdvisors();
  }, [participantsModal, selectedRoom?.key]);

  const roomMembers = selectedRoom?.attributes?.members ?? [];
  const primaryId = (selectedRoom?.attributes?.advisorId ?? '').trim();
  const memberIds = new Set(
    [...roomMembers.map((m) => (m.memberId ?? '').trim()).filter(Boolean), primaryId].filter(Boolean)
  );
  const roomAdvisorType = (selectedRoom?.attributes?.advisorType ?? '').toUpperCase();
  const advisorsToAdd = availableAdvisors.filter(
    (a) => !memberIds.has(a.key) && a.type === roomAdvisorType
  );
  const isPrimaryAdvisor = selectedRoom?.attributes?.advisorId === ADVISOR_ID;
  const isRoomDeactivated = selectedRoom?.metadata?.currentState === 'deactivated';

  const handleAddParticipant = async () => {
    const instanceId = selectedRoom?.id ?? selectedRoom?.key;
    if (!instanceId || !addParticipantId.trim()) return;
    try {
      const res = await runTransition('chat-room', instanceId, 'update', {
        attributes: {
          newMemberId: addParticipantId.trim(),
          historyVisibility: addParticipantHistoryVisibility,
        },
      });
      if (res.ok) {
        toast('Katılımcı eklendi', 'success');
        setAddParticipantId('');
        fetchRooms();
        setSelectedRoom((prev) => {
          if (!prev) return prev;
          const newMembers = [...(prev.attributes?.members ?? []), { memberId: addParticipantId.trim(), role: 'member' }];
          return { ...prev, attributes: { ...prev.attributes, members: newMembers } };
        });
      } else {
        toast('Katılımcı eklenemedi: ' + (res.data as { error?: string })?.error, 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const handleRemoveParticipant = async (removeMemberId: string) => {
    const instanceId = selectedRoom?.id ?? selectedRoom?.key;
    if (!instanceId || !removeMemberId.trim()) return;
    try {
      const res = await runTransition('chat-room', instanceId, 'remove', { attributes: { removeMemberId: removeMemberId.trim() } });
      if (res.ok) {
        toast('Katılımcı çıkarıldı', 'success');
        fetchRooms();
        setSelectedRoom((prev) => {
          if (!prev) return prev;
          const newMembers = (prev.attributes?.members ?? []).filter((m) => (m.memberId ?? '') !== removeMemberId);
          return { ...prev, attributes: { ...prev.attributes, members: newMembers } };
        });
      } else {
        toast('Katılımcı çıkarılamadı: ' + (res.data as { error?: string })?.error, 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const toggleFavorite = (key: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      saveFavorites(next);
      return next;
    });
  };

  const filteredRooms = rooms.filter((r) => {
    const name = userName(r.attributes?.user).toLowerCase();
    const matchSearch = !search || name.includes(search.toLowerCase());
    const matchFav = !showFavoritesOnly || favorites.has(r.key);
    return matchSearch && matchFav;
  });

  /* ── render ── */

  return (
    <div className="page">
      <div className="page-header">
        <h1>Chat Yönetimi</h1>
      </div>

      <div className="chat-layout">
        <div className="chat-list">
          <div className="chat-list-header">
            <input
              type="text"
              className="form-input"
              placeholder="Ara..."
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              style={{ marginBottom: 8 }}
            />
            <label className="flex items-center gap-2" style={{ fontSize: 12, cursor: 'pointer' }}>
              <input
                type="checkbox"
                checked={showFavoritesOnly}
                onChange={(e) => setShowFavoritesOnly(e.target.checked)}
              />
              Favoriler
            </label>
          </div>
          <div className="chat-list-items">
            {loading ? (
              <div className="empty-state">
                <MessageSquare size={32} className="animate-spin" />
                <p>Yükleniyor...</p>
              </div>
            ) : filteredRooms.length === 0 ? (
              <EmptyState message={rooms.length === 0 ? 'Aktif chat yok' : 'Eşleşen chat bulunamadı'} />
            ) : (
              filteredRooms.map((room, idx) => {
                const roomKey = room.key || `room-${idx}`;
                const isActive = selectedRoom?.key === room.key;
                const isUnread = unreadRooms.has(roomKey);
                const isFav = favorites.has(roomKey);
                return (
                  <div
                    key={roomKey}
                    className={cn(
                      'chat-list-item',
                      isActive && 'active',
                      isUnread && 'unread',
                      room.attributes?.advisorId !== ADVISOR_ID && 'member-room',
                      room.metadata?.currentState === 'deactivated' && 'chat-list-item-disabled'
                    )}
                    onClick={() => {
                      setSelectedRoom(room);
                      setUnreadRooms((u) => {
                        const n = new Set(u);
                        n.delete(roomKey);
                        return n;
                      });
                    }}
                  >
                    {isUnread && <span className="unread-dot" />}
                    <div className="chat-item-avatar">
                      <span style={{ fontSize: 14 }}>{userName(room.attributes?.user).charAt(0)}</span>
                    </div>
                    <div className="chat-item-info">
                      <div className="chat-item-name">{userName(room.attributes?.user)}</div>
                      <div className="chat-item-preview">
                        {(room.attributes?.members?.length ?? 0)} kişi ·{' '}
                        {room.attributes?.advisorId === ADVISOR_ID ? 'Asıl danışman' : 'Üye'}
                      </div>
                    </div>
                    <button
                      className="btn-icon"
                      style={{ flexShrink: 0 }}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFavorite(roomKey);
                      }}
                      title={isFav ? 'Favorilerden çıkar' : 'Favorilere ekle'}
                    >
                      <Star size={16} fill={isFav ? 'currentColor' : 'none'} />
                    </button>
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
                    {userName(selectedRoom.attributes?.user)}
                  </h3>
                  <span
                    className="badge badge-sm"
                    style={{ '--badge-color': 'var(--color-muted)' } as React.CSSProperties}
                  >
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
                  {isPrimaryAdvisor && !isRoomDeactivated && (
                    <button
                      className="btn btn-secondary btn-sm"
                      onClick={() => setTransferModal(true)}
                      title="Devret"
                    >
                      <UserPlus size={14} />
                      Devret
                    </button>
                  )}
                  {isPrimaryAdvisor && (
                    <div
                      ref={statusDropdownRef}
                      className="status-selector"
                      style={{ position: 'relative', opacity: statusTransitionLoading ? 0.7 : 1, pointerEvents: statusTransitionLoading ? 'none' : 'auto' }}
                      onClick={() => setStatusDropdownOpen((o) => !o)}
                      title={isRoomDeactivated ? 'Aktife al' : 'Pasife al'}
                    >
                      <span
                        className="status-dot"
                        style={{ background: isRoomDeactivated ? '#6b7280' : '#22c55e' }}
                      />
                      <span className="status-label">{isRoomDeactivated ? 'Pasif' : 'Aktif'}</span>
                      <ChevronDown size={14} />
                      {statusDropdownOpen && (
                        <div className="status-dropdown">
                          {isRoomDeactivated ? (
                            <button
                              type="button"
                              className="status-option"
                              onClick={(e) => { e.stopPropagation(); handleActivate(); }}
                            >
                              <span className="status-dot" style={{ background: '#22c55e' }} />
                              Aktife al
                            </button>
                          ) : (
                            <button
                              type="button"
                              className="status-option"
                              onClick={(e) => { e.stopPropagation(); handleDeactivate(); }}
                            >
                              <span className="status-dot" style={{ background: '#6b7280' }} />
                              Pasife al
                            </button>
                          )}
                        </div>
                      )}
                    </div>
                  )}
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
                              {m.sender?.replace(/@|:.*/g, '') || 'Müşteri'}
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
                  disabled={sending || isRoomDeactivated}
                >
                  <Paperclip size={18} />
                </button>
                <input
                  type="text"
                  className="form-input"
                  placeholder={isRoomDeactivated ? 'Görüşme pasif. Aktife almak için yukarıdaki menüyü kullanın.' : 'Mesaj yazın...'}
                  value={inputText}
                  onChange={(e) => setInputText(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && !e.shiftKey && handleSend()}
                  disabled={isRoomDeactivated}
                />
                <button
                  className="btn btn-primary btn-sm"
                  onClick={handleSend}
                  disabled={sending || !inputText.trim() || isRoomDeactivated}
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
        open={transferModal}
        onClose={() => setTransferModal(false)}
        title="Chat Devret"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setTransferModal(false)}>
              İptal
            </button>
            <button
              className="btn btn-primary"
              onClick={handleTransfer}
              disabled={!transferTargetId.trim()}
            >
              Devret
            </button>
          </>
        }
      >
        <div className="form-group">
          <label className="form-label">Hedef Danışman ID</label>
          <input
            type="text"
            className="form-input"
            placeholder="advisor-2"
            value={transferTargetId}
            onChange={(e) => setTransferTargetId(e.target.value)}
          />
        </div>
      </Modal>

      <Modal
        open={participantsModal}
        onClose={() => {
          setParticipantsModal(false);
          setAddParticipantId('');
          setAddParticipantHistoryVisibility('shared');
        }}
        title="Katılımcılar"
        footer={
          <button className="btn btn-primary" onClick={() => setParticipantsModal(false)}>
            Kapat
          </button>
        }
      >
        <div className="form-group">
          <label className="form-label">Mevcut katılımcılar</label>
          <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px 0' }}>
            {roomMembers.map((m) => {
              const mid = (m.memberId ?? '').trim();
              const role = (m.role ?? '').trim();
              const roleLabel = role === 'owner' ? 'Müşteri' : role === 'advisor' ? 'Asıl Danışman' : 'Üye';
              const canRemove = isPrimaryAdvisor && !isRoomDeactivated && role === 'member';
              return (
                <li
                  key={mid}
                  className="flex items-center justify-between"
                  style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
                >
                  <span>{mid}</span>
                  <div className="flex items-center gap-2">
                    <span className="badge badge-sm" style={{ '--badge-color': 'var(--color-muted)' } as React.CSSProperties}>
                      {roleLabel}
                    </span>
                    {canRemove && (
                      <button
                        type="button"
                        className="btn btn-secondary btn-sm"
                        onClick={() => handleRemoveParticipant(mid)}
                      >
                        Çıkar
                      </button>
                    )}
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
        {isPrimaryAdvisor && !isRoomDeactivated && (
          <div className="form-group">
            <label className="form-label">Yeni katılımcı ekle</label>
            <div className="flex gap-2">
              <select
                className="form-input"
                value={addParticipantId}
                onChange={(e) => setAddParticipantId(e.target.value)}
                disabled={participantsLoading || advisorsToAdd.length === 0}
              >
                <option value="">Danışman seçin...</option>
                {advisorsToAdd.map((a) => (
                  <option key={a.key} value={a.key}>
                    {a.name} ({a.type})
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                onClick={handleAddParticipant}
                disabled={!addParticipantId.trim()}
              >
                Ekle
              </button>
            </div>
            <fieldset style={{ marginTop: 16, border: 'none', padding: 0 }}>
              <legend className="form-label" style={{ marginBottom: 8 }}>
                Yeni üye mesaj geçmişini görsün mü?
              </legend>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                {HISTORY_VISIBILITY_OPTIONS.map((opt) => (
                  <label
                    key={opt.value}
                    className="flex items-start gap-2"
                    style={{ cursor: 'pointer', fontSize: 13 }}
                  >
                    <input
                      type="radio"
                      name="historyVisibility"
                      checked={addParticipantHistoryVisibility === opt.value}
                      onChange={() => setAddParticipantHistoryVisibility(opt.value)}
                      style={{ marginTop: 3 }}
                    />
                    <span>
                      <strong style={{ fontWeight: 600 }}>{opt.label}</strong>
                      <span style={{ display: 'block', color: 'var(--color-muted)', fontSize: 12 }}>
                        {opt.hint}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            </fieldset>
          </div>
        )}
      </Modal>

    </div>
  );
}
