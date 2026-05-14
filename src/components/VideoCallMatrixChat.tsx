import { Fragment, useCallback, useEffect, useRef, useState } from 'react';
import { MessageSquare, Send } from 'lucide-react';
import { getMatrixSync, getRoomMessages, sendRoomMessage } from '../lib/api';
import { formatDate, formatTime, cn } from '../lib/utils';
import { EmptyState, toast } from './ui';
import { customerDisplayName, getCustomerName } from '../data/customers';

const SYNC_MIN_INTERVAL_MS = 2000;
const SYNC_IDLE_DELAY_MS = 5000;
const SYNC_ERROR_DELAY_MS = 3000;
const PENDING_PREFIX = 'pending-';

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

interface SyncResponse {
  nextBatch: string | null;
  eventsByRoom: Record<string, Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>>;
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

function isCustomerSender(sender: string | undefined, customerId: string): boolean {
  if (!sender || !customerId) return false;
  const customerMatrixId = `@${customerId}:localhost`;
  return sender.includes(customerId) || sender === customerMatrixId;
}

function isAdvisorSender(sender: string | undefined, advisorId: string): boolean {
  if (!sender || !advisorId) return false;
  const localpart = sender.replace(/^@/, '').split(':')[0]?.trim().toLowerCase() ?? '';
  if (!localpart) return false;
  const adv = advisorId.trim().toLowerCase();
  return localpart === adv || localpart === `u${adv}`;
}

function mergeCustomer(
  prev: ChatMessage[],
  newMsgs: Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>,
  customerId: string,
): ChatMessage[] {
  const existingIds = new Set(prev.map((m) => m.eventId).filter(Boolean));
  const toAdd = newMsgs
    .filter((m) => m.eventId && !existingIds.has(m.eventId))
    .map((m) => ({
      ...m,
      isMine: isCustomerSender(m.sender, customerId),
      read: false,
    }));
  if (toAdd.length === 0) return prev;
  const fromUs = toAdd.filter((m) => isCustomerSender(m.sender, customerId));
  const withoutOptimistic =
    fromUs.length > 0
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

function mergeAdvisor(
  prev: ChatMessage[],
  newMsgs: Array<{ eventId?: string; sender?: string; body?: string; timestamp?: string; msgtype?: string }>,
  advisorId: string,
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
  const withoutOptimistic =
    fromUs.length > 0
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

/** Müşteri görüşmesi: {@link Chat.tsx} ile aynı header/sync/gönderim sözleşmesi. */
type VideoCallMatrixChatCustomerProps = {
  matrixRoomId: string | null;
  role: 'customer';
  customerId: string;
  /** CustomerContext.customerName — kendi balonunda gösterim. */
  customerDisplayName?: string;
  /** Karşı taraf etiketi; Chat’teki danışman adı yoksa "Danışman". */
  advisorPeerLabel?: string;
};

/** Danışman görüşmesi: {@link ChatManagement.tsx} ile aynı `userType: 'advisor'` sözleşmesi. */
type VideoCallMatrixChatAdvisorProps = {
  matrixRoomId: string | null;
  role: 'advisor';
  advisorId: string;
  advisorDisplayName?: string;
  /** Randevu `attributes.user` — ChatManagement’taki müşteri ismi çözümü. */
  customerTouchHint?: string | null;
};

export type VideoCallMatrixChatProps = VideoCallMatrixChatCustomerProps | VideoCallMatrixChatAdvisorProps;

export function VideoCallMatrixChat(props: VideoCallMatrixChatProps) {
  const { matrixRoomId, role } = props;
  const touchUser = role === 'customer' ? props.customerId : props.advisorId;
  const customerId = role === 'customer' ? props.customerId : '';
  const advisorId = role === 'advisor' ? props.advisorId : '';
  const customerDisplayNameProp = role === 'customer' ? props.customerDisplayName : undefined;
  const advisorPeerLabel = role === 'customer' ? props.advisorPeerLabel : undefined;
  const advisorDisplayNameProp = role === 'advisor' ? props.advisorDisplayName : undefined;
  const customerTouchHint = role === 'advisor' ? props.customerTouchHint : undefined;

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [messagesLoading, setMessagesLoading] = useState(false);
  const [inputText, setInputText] = useState('');
  const [sending, setSending] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const syncTokenRef = useRef<string | null>(null);
  const syncAbortedRef = useRef(false);
  const inFlightRef = useRef(false);

  const renderSenderName = useCallback(
    (sender?: string): string => {
      if (role === 'customer') {
        if (isCustomerSender(sender, customerId)) {
          return customerDisplayNameProp?.trim() || customerId || 'Siz';
        }
        return advisorPeerLabel?.trim() || 'Danışman';
      }
      if (isAdvisorSender(sender, advisorId)) {
        return advisorDisplayNameProp?.trim() || 'Siz';
      }
      const localpart = (sender ?? '').replace(/^@/, '').split(':')[0]?.trim() ?? '';
      if (!localpart) {
        return customerTouchHint ? customerDisplayName(customerTouchHint) : 'Müşteri';
      }
      const stripped = localpart.replace(/^u/i, '');
      const fromRoster =
        getCustomerName(localpart) ?? getCustomerName(stripped) ?? (customerTouchHint ? getCustomerName(customerTouchHint) : undefined);
      if (fromRoster) return fromRoster;
      return customerTouchHint ? customerDisplayName(customerTouchHint) : customerDisplayName(stripped || localpart);
    },
    [role, customerId, advisorId, customerDisplayNameProp, advisorPeerLabel, advisorDisplayNameProp, customerTouchHint],
  );

  useEffect(() => {
    if (!matrixRoomId || !touchUser) {
      setMessages([]);
      return;
    }
    let cancelled = false;
    (async () => {
      setMessagesLoading(true);
      setMessages([]);
      try {
        const headers: Record<string, string> = { roomId: matrixRoomId, touchUser };
        if (role === 'advisor') headers.userType = 'advisor';
        const res = await getRoomMessages({ limit: '50', pageSize: '1' }, headers);
        if (cancelled) return;
        const apiMsgs = extractMessages(res);
        const msgs = [...apiMsgs].reverse().map((m) => ({
          ...m,
          isMine:
            role === 'advisor'
              ? isAdvisorSender(m.sender, advisorId)
              : isCustomerSender(m.sender, customerId),
          read: false,
        }));
        setMessages(msgs);
      } catch (e) {
        if (!cancelled) toast(String(e), 'error');
      } finally {
        if (!cancelled) setMessagesLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [matrixRoomId, touchUser, role, customerId, advisorId]);

  useEffect(() => {
    if (!matrixRoomId || !touchUser) return;
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
          timeout: string;
          roomId: string;
          since?: string;
          userType?: string;
        } = {
          user: touchUser,
          timeout: syncTokenRef.current ? '30000' : '0',
          roomId: matrixRoomId,
        };
        if (role === 'advisor') params.userType = 'advisor';
        if (syncTokenRef.current) params.since = syncTokenRef.current;

        const res = await getMatrixSync(params);
        if (syncAbortedRef.current) return;
        const syncData = extractSyncResponse(res);
        if (syncData) {
          if (syncData.nextBatch) syncTokenRef.current = syncData.nextBatch;
          const roomEvents = syncData.eventsByRoom?.[matrixRoomId];
          if (Array.isArray(roomEvents) && roomEvents.length > 0) {
            setMessages((prev) =>
              role === 'advisor'
                ? mergeAdvisor(prev, roomEvents, advisorId)
                : mergeCustomer(prev, roomEvents, customerId),
            );
            hadRoomEvents = true;
          }
        } else {
          errored = true;
        }
      } catch {
        errored = true;
      }
      if (syncAbortedRef.current) return;
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
  }, [matrixRoomId, touchUser, role, customerId, advisorId]);

  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = inputText.trim();
    if (!text || !matrixRoomId || inFlightRef.current) return;
    inFlightRef.current = true;
    setSending(true);
    const tempId = `${PENDING_PREFIX}${Date.now()}`;
    const optimisticSender = `@${touchUser}:localhost`;
    setMessages((prev) => [
      ...prev,
      {
        eventId: tempId,
        body: text,
        sender: optimisticSender,
        timestamp: Date.now(),
        isMine: true,
        read: false,
        failed: false,
      },
    ]);
    setInputText('');
    try {
      const res =
        role === 'advisor'
          ? await sendRoomMessage(matrixRoomId, touchUser, text, { userType: 'advisor' })
          : await sendRoomMessage(matrixRoomId, touchUser, text);
      if (!res.ok) throw new Error(`HTTP ${res.status || 'error'}`);
    } catch (e) {
      setMessages((prev) => prev.map((m) => (m.eventId === tempId ? { ...m, failed: true } : m)));
      toast(e instanceof Error ? e.message : String(e) || 'Mesaj gönderilemedi', 'error');
    } finally {
      inFlightRef.current = false;
      setSending(false);
    }
  };

  if (!matrixRoomId) return null;

  return (
    <div
      className="video-call-matrix-chat"
      style={{
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
        maxHeight: 'min(38vh, 320px)',
        borderTop: '1px solid var(--color-border)',
        background: 'var(--color-surface)',
      }}
    >
      <div className="chat-panel-header" style={{ padding: '8px 12px', flexShrink: 0 }}>
        <h3 style={{ fontSize: 13, fontWeight: 600, margin: 0 }}>Sohbet</h3>
      </div>
      <div className="chat-messages" style={{ flex: 1, minHeight: 0, padding: '8px 12px', gap: 6 }}>
        {messagesLoading ? (
          <div className="empty-state" style={{ padding: 12 }}>
            <MessageSquare size={24} className="animate-spin" />
            <p className="text-sm">Yükleniyor…</p>
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
                  {!m.isMine && <div className="chat-msg-sender">{renderSenderName(m.sender)}</div>}
                  <div className="chat-msg-body">{m.body ?? m.content ?? ''}</div>
                  <div className="chat-msg-meta">{formatTime(m.timestamp)}</div>
                </div>
              ))}
            </Fragment>
          ))
        )}
        <div ref={messagesEndRef} />
      </div>
      <form
        className="chat-input-area"
        style={{ padding: '8px 12px', flexShrink: 0 }}
        onSubmit={(e) => {
          e.preventDefault();
          void handleSend();
        }}
      >
        <input
          type="text"
          className="form-input"
          placeholder="Mesaj…"
          value={inputText}
          onChange={(e) => setInputText(e.target.value)}
          disabled={sending}
        />
        <button type="submit" className="btn btn-primary btn-sm" disabled={sending || !inputText.trim()}>
          <Send size={14} />
        </button>
      </form>
    </div>
  );
}
