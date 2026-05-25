import { useEffect, useState, useCallback, useRef, Fragment } from 'react';
import {
  Star,
  Send,
  Paperclip,
  ChevronDown,
  UserPlus,
  Users,
  MessageSquare,
  FileText,
} from 'lucide-react';
import { getChatRooms, getRoomMessages, sendRoomMessage, getMatrixSync, runTransition, listInstances, getInstance } from '../../lib/api';
import { formatTime, formatDate, cn } from '../../lib/utils';
import { EmptyState, Modal, toast } from '../../components/ui';
import { CustomerNotesModal } from '../../components/CustomerNotesModal';
import { useAdvisorContext } from '../../contexts/AdvisorContext';
import { HISTORY_VISIBILITY_OPTIONS, type MatrixHistoryVisibility } from '../../lib/matrixChat';
import { getCustomerName } from '../../data/customers';

type AdvisorWorkflow = 'portfolio-manager' | 'investment-advisor';

const FAVORITES_KEY = 'chat-favorites';
const MAX_FILE_SIZE_MB = 10;
const ALLOWED_EXTENSIONS = ['.xlsx', '.docx', '.pdf', '.jpg', '.jpeg', '.png'];

// Matrix /sync long-poll back-off bounds.
// Synapse can return quickly when device_lists / one_time_keys streams advance
// (independent of our room filter), so we throttle the loop to avoid hammering
// the runtime. The minimum interval applies even on happy responses; the idle
// delay kicks in when the long-poll returned with no new room events.
const SYNC_MIN_INTERVAL_MS = 200;
const SYNC_IDLE_DELAY_MS = 5000;
const SYNC_ERROR_DELAY_MS = 3000;

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
  failed?: boolean;
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

/** Müşteri TCKN'sini görünür isim soyisme dönüştür (mock roster'dan), bulunmazsa TCKN'i döner. */
function customerDisplayName(ref: unknown): string {
  const id = userName(ref);
  if (!id || id === '—') return '—';
  return getCustomerName(id) ?? id;
}

/** advisorType → workflow adı. Bilinmiyorsa null. */
function workflowFromAdvisorType(advisorType?: string): AdvisorWorkflow | null {
  const t = (advisorType ?? '').trim().toUpperCase();
  if (t === 'PM') return 'portfolio-manager';
  if (t === 'IA') return 'investment-advisor';
  return null;
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

/**
 * True when the Matrix sender id belongs to the current advisor.
 *
 * Synapse stores localparts case-insensitively and our scripting layer normalizes
 * non-alphabetic-leading ids (e.g. numeric or uppercase sicil) with a leading "u"
 * before registration. So the advisor `U02917` shows up on the wire as
 * `@u02917:localhost`. A plain `.includes(ADVISOR_ID)` then misses the message
 * and the bubble lands on the wrong side. We compare on the normalized localpart
 * with both `<sicil>` and `u<sicil>` variants.
 */
function isAdvisorSender(sender: string | undefined, advisorId: string): boolean {
  if (!sender || !advisorId) return false;
  const localpart = sender.replace(/^@/, '').split(':')[0]?.trim().toLowerCase() ?? '';
  if (!localpart) return false;
  const adv = advisorId.trim().toLowerCase();
  return localpart === adv || localpart === `u${adv}`;
}

function mergeNewMessages(
  prev: ChatMessage[],
  newMsgs: Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>,
  advisorId: string
): ChatMessage[] {
  const existingIds = new Set(prev.map((m) => m.eventId).filter(Boolean));
  const toAdd = newMsgs
    .filter((m) => m.eventId && !existingIds.has(m.eventId))
    .map((m) => ({
      ...m,
      isMine: isAdvisorSender(m.sender, advisorId),
      read: false,
    }));
  if (toAdd.length === 0) return prev;

  const fromUs = toAdd.filter((m) => isAdvisorSender(m.sender, advisorId));
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
  const [notesCustomer, setNotesCustomer] = useState<string | null>(null);
  const [statusDropdownOpen, setStatusDropdownOpen] = useState(false);
  const [statusTransitionLoading, setStatusTransitionLoading] = useState(false);
  const [transferTargetId, setTransferTargetId] = useState('');
  const [unreadRooms, setUnreadRooms] = useState<Set<string>>(new Set());
  // sicil (örn. "U02917") → isim soyisim ("MERVE YILDIZ"). Hem birincil advisor
  // hem de room.members içindeki advisor sicilleri için lazy doldurulur; UI'da
  // sicil/TCKN ham olarak gözükmesin diye sohbet listesi, panel başlığı,
  // katılımcılar modali ve mesaj balonu sender etiketinde kullanılır.
  const [advisorNames, setAdvisorNames] = useState<Record<string, string>>({});
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const statusDropdownRef = useRef<HTMLDivElement>(null);
  const syncTokenRef = useRef<string | null>(null);
  const syncAbortedRef = useRef(false);
  const inFlightRef = useRef(false);

  /* ── fetch rooms (same as customer, advisor param instead of user) ── */

  const fetchRooms = useCallback(async (): Promise<ChatRoomInstance[]> => {
    setLoading(true);
    try {
      const res = await getChatRooms({ touchUser: ADVISOR_ID, userType: 'advisor' });
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
            { roomId: matrixRoomId, touchUser: ADVISOR_ID, userType: 'advisor' }
          );
          const apiMsgs = extractMessages(res);
          msgs = [...apiMsgs].reverse().map((m) => ({
            ...m,
            isMine: isAdvisorSender(m.sender, ADVISOR_ID),
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
      const startedAt = Date.now();
      let hadRoomEvents = false;
      let errored = false;
      try {
        const params: {
          user: string;
          userType: string;
          timeout: string;
          roomId: string;
          since?: string;
        } = {
          user: ADVISOR_ID,
          userType: 'advisor',
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
            setMessages((prev) => mergeNewMessages(prev, roomEvents, ADVISOR_ID));
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
  }, [selectedRoom?.key, ADVISOR_ID]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  /* ── advisor name resolution (sicil → isim soyisim) ──
   * Aktif odaların birincil advisorId'si + members listesindeki üye sicilleri
   * için portfolio-manager / investment-advisor instance'larından firstName +
   * lastName çekilir. Tip biliniyorsa tek workflow sorgulanır; bilinmiyorsa
   * iki workflow paralel denenir. ChatManagement'ta CustomerContext yok; bu
   * yüzden müşteri ismi mock roster'dan (`getCustomerName`) çözülür. */
  useEffect(() => {
    if (rooms.length === 0) return;
    let cancelled = false;

    type Target = { key: string; workflow: AdvisorWorkflow };
    const seen = new Set<string>();
    const targets: Target[] = [];
    const pushTarget = (id: string | undefined, advisorType?: string) => {
      if (!id) return;
      const trimmed = id.trim();
      if (!trimmed || seen.has(trimmed)) return;
      seen.add(trimmed);
      const wf = workflowFromAdvisorType(advisorType);
      if (wf) targets.push({ key: trimmed, workflow: wf });
      else {
        targets.push({ key: trimmed, workflow: 'portfolio-manager' });
        targets.push({ key: trimmed, workflow: 'investment-advisor' });
      }
    };

    for (const r of rooms) {
      pushTarget(r.attributes?.advisorId, r.attributes?.advisorType);
      for (const m of r.attributes?.members ?? []) {
        const role = (m.role ?? '').trim();
        // owner = müşteri (TCKN), advisor/member = sicil → sicil olanları çöz
        if (role === 'owner') continue;
        pushTarget(m.memberId, r.attributes?.advisorType);
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
        /* listInstances fallback aşağıda */
      }
      try {
        const list = await listInstances(workflow, { pageSize: 100 });
        if (list.ok && list.data) {
          const items = (list.data as { items?: { key?: string; attributes?: Record<string, unknown> }[] }).items ?? [];
          const match = items.find((i) => i.key === key);
          if (match) return buildName(match.attributes);
        }
      } catch {
        /* yut */
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

  /** Matrix `@localpart:server` → kullanıcı dostu isim. Müşteri (TCKN/u+TCKN)
   * ise mock roster'dan; sicil/u+sicil ise advisorNames map'inden çek. Hiçbiri
   * eşleşmezse seçili odadaki muhatap rolüne göre "Müşteri" / "Danışman"
   * fallback'i — sicil ve TCKN ekrana asla yansımaz. */
  const renderSenderName = useCallback(
    (sender?: string): string => {
      const localpart = (sender ?? '').replace(/@|:.*/g, '').trim();
      if (!localpart) return 'Danışman';
      const lower = localpart.toLowerCase();

      // Müşteri kontrolü: odanın user'ı / room.members owner'ı
      const customerId = userName(selectedRoom?.attributes?.user).trim();
      const cidLower = customerId.toLowerCase();
      if (cidLower && (lower === cidLower || lower === `u${cidLower}`)) {
        return customerDisplayName(selectedRoom?.attributes?.user);
      }

      // Advisor kontrolü: advisorNames içindeki anahtarlarla case + u-prefix toleranslı eşle
      const matchKey = Object.keys(advisorNames).find((k) => {
        const kl = k.toLowerCase();
        return kl === lower || `u${kl}` === lower || kl === `u${lower}`;
      });
      if (matchKey) return advisorNames[matchKey];

      // Mesajı atan biz miyiz? (kendi sicilim)
      const myLower = ADVISOR_ID.toLowerCase();
      if (lower === myLower || lower === `u${myLower}`) {
        return advisorNames[ADVISOR_ID] ?? 'Danışman';
      }
      return 'Danışman';
    },
    [advisorNames, selectedRoom, ADVISOR_ID],
  );

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
        sender: `@${ADVISOR_ID}:localhost`,
        timestamp: Date.now(),
        isMine: true,
        read: false,
        failed: false,
      },
    ]);
    setInputText('');

    try {
      const res = await sendRoomMessage(matrixRoomId, ADVISOR_ID, text, { userType: 'advisor' });
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
        const pmItems: Array<{ key: string; attributes?: Record<string, unknown> }> = pmRes.ok
          ? ((pmRes.data as { items?: Array<{ key: string; attributes?: Record<string, unknown> }> })?.items ?? [])
          : [];
        const iaItems: Array<{ key: string; attributes?: Record<string, unknown> }> = iaRes.ok
          ? ((iaRes.data as { items?: Array<{ key: string; attributes?: Record<string, unknown> }> })?.items ?? [])
          : [];
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
    const haystack = `${customerDisplayName(r.attributes?.user)} ${userName(r.attributes?.user)}`.toLowerCase();
    const matchSearch = !search || haystack.includes(search.toLowerCase());
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
                      <span style={{ fontSize: 14 }}>
                        {(() => {
                          const tckn = userName(room.attributes?.user);
                          const name = tckn !== '—' ? getCustomerName(tckn) : undefined;
                          const first = (name ?? tckn ?? '?').charAt(0);
                          return (first || '?').toUpperCase();
                        })()}
                      </span>
                    </div>
                    <div className="chat-item-info">
                      {(() => {
                        const tckn = userName(room.attributes?.user);
                        const name = tckn !== '—' ? getCustomerName(tckn) : undefined;
                        return (
                          <>
                            <div className="chat-item-name">{tckn}</div>
                            {name && (
                              <div className="text-muted text-xs" style={{ lineHeight: 1.2 }}>
                                {name}
                              </div>
                            )}
                          </>
                        );
                      })()}
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
                  {(() => {
                    const tckn = userName(selectedRoom.attributes?.user);
                    const name = tckn !== '—' ? getCustomerName(tckn) : undefined;
                    return (
                      <div className="flex flex-col" style={{ lineHeight: 1.2 }}>
                        <span style={{ fontSize: 15, fontWeight: 600 }}>{tckn}</span>
                        {name && (
                          <span className="text-muted text-xs">{name}</span>
                        )}
                      </div>
                    );
                  })()}
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
                  <button
                    className="btn btn-secondary btn-sm"
                    onClick={() => setNotesCustomer(userName(selectedRoom.attributes?.user))}
                    title="Müşteri Notları"
                  >
                    <FileText size={14} />
                    Müşteri Notları
                  </button>
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
                  disabled={isRoomDeactivated || !getMatrixRoomId(selectedRoom)}
                />
                <button
                  type="submit"
                  className="btn btn-primary btn-sm"
                  disabled={sending || !inputText.trim() || isRoomDeactivated || !getMatrixRoomId(selectedRoom)}
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
              // owner ise TCKN → müşteri ismi, advisor/member ise sicil → advisor ismi.
              // Resolve tamamlanana dek ham id'yi göstermek yerine rol etiketine düş.
              const displayName = role === 'owner'
                ? (getCustomerName(mid) ?? mid)
                : (advisorNames[mid] ?? mid);
              return (
                <li
                  key={mid}
                  className="flex items-center justify-between"
                  style={{ padding: '8px 0', borderBottom: '1px solid var(--color-border)' }}
                >
                  <span>{displayName}</span>
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

      <CustomerNotesModal
        open={!!notesCustomer}
        onClose={() => setNotesCustomer(null)}
        customerLoginName={notesCustomer ?? ''}
        customerTckn={notesCustomer ?? ''}
        advisorLoginName={ADVISOR_ID}
        customerDisplayName={notesCustomer ? getCustomerName(notesCustomer) ?? notesCustomer : undefined}
      />

    </div>
  );
}
