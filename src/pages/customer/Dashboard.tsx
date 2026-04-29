import { useEffect, useState, useCallback, Fragment } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  MessageSquare,
  CalendarDays,
  Briefcase,
  TrendingUp,
  Video,
  Pencil,
  Trash2,
  RefreshCw,
  Clock,
  ChevronRight,
  Info,
} from 'lucide-react';
import {
  getReservations,
  getChatRooms,
  getRoomMessages,
  getAvailableSlots,
  startInstance,
  runTransition,
  getInstance,
} from '../../lib/api';
import { formatDateTime, formatTime, formatDate, cn, toUtcIsoFromDateAndTime } from '../../lib/utils';
import { useCustomerContext } from '../../contexts/CustomerContext';
import { Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: string;
    advisor?: string;
    startDateTime?: string;
    endDateTime?: string;
    videoCallUrls?: Record<string, string>[];
  };
  metadata?: { currentState?: string };
}

interface ChatRoomMember {
  memberId: string;
  role: string;
}

interface RoomMessage {
  eventId?: string;
  body?: string;
  content?: string;
  sender?: string;
  timestamp?: string | number;
  isMine?: boolean;
}

interface ChatRoomInstance {
  instanceKey: string;
  user?: string;
  advisorType?: string;
  advisorId?: string;
  roomId?: string;
  status?: string;
  roomType?: string;
  startDateTime?: string | null;
  endDateTime?: string | null;
  members?: ChatRoomMember[];
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  getChatRooms?: { items?: T[]; rooms?: T[] };
  [key: string]: unknown;
}

function extractReservations(res: { ok: boolean; data?: unknown }): ReservationInstance[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<ReservationInstance>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function extractChatRooms(res: { ok: boolean; data?: unknown }): ChatRoomInstance[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as { items?: Array<{ getChatRooms?: { rooms?: ChatRoomInstance[] } }> };
  const items = d?.items;
  if (!Array.isArray(items) || items.length === 0) return [];
  const rooms = items[0]?.getChatRooms?.rooms;
  return Array.isArray(rooms) ? rooms : [];
}

function extractSlotItems(res: { ok: boolean; data?: unknown }): { start: string; end: string }[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;
  let raw: unknown[] = [];
  const getSlots = d?.getAvailableSlots as { availableSlots?: string[]; items?: { start?: string; end?: string }[] } | undefined;
  if (getSlots?.availableSlots) {
    raw = getSlots.availableSlots;
  } else if (Array.isArray(d?.items) && d.items.length > 0) {
    const first = (d.items as Record<string, unknown>[])[0];
    const nested = first?.getAvailableSlots as { availableSlots?: string[] } | undefined;
    raw = nested?.availableSlots ?? [];
  } else {
    raw = getSlots?.items ?? (d?.items as unknown[] | undefined) ?? [];
  }
  if (!Array.isArray(raw)) return [];
  return raw
    .map((s) => {
      if (typeof s === 'string') {
        const [start, end] = s.split('-');
        return { start: start?.trim() ?? '', end: end?.trim() ?? '' };
      }
      const obj = s as { start?: string; end?: string };
      return { start: obj.start ?? '', end: obj.end ?? '' };
    })
    .filter((slot) => slot.start && slot.end);
}

function getRoomTypeLabel(roomType?: string): string {
  return roomType === 'permanent' ? 'Kalıcı Oda' : roomType === 'rezervation' ? 'Rezervasyon' : roomType ?? '—';
}

function getRoomAdvisors(room: ChatRoomInstance): string {
  const members = room.members ?? [];
  const advisors = members
    .filter((m) => m.role === 'advisor' || m.role === 'member')
    .map((m) => m.memberId);
  return advisors.length > 0 ? advisors.join(', ') : room.advisorId ?? '—';
}

function getRoomDateDisplay(room: ChatRoomInstance): string {
  if (room.roomType === 'rezervation' && (room.startDateTime || room.endDateTime)) {
    const start = room.startDateTime ? formatDateTime(room.startDateTime) : '';
    const end = room.endDateTime ? formatDateTime(room.endDateTime) : '';
    return start && end ? `${start} – ${end}` : start || end || '—';
  }
  return '—';
}

function groupMessagesByDate(msgs: RoomMessage[]): Record<string, RoomMessage[]> {
  const grouped: Record<string, RoomMessage[]> = {};
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

function customerNumber(customerId: string): string {
  const m = customerId.match(/user-?(\d+)$/);
  return m ? m[1] : '001';
}

/** Runtime may return currentState under metadata, root, nested instance/data, or items[0]. */
function extractWorkflowCurrentState(payload: unknown): string {
  if (payload == null || typeof payload !== 'object') return '';
  const o = payload as Record<string, unknown>;
  const meta = o.metadata;
  if (meta && typeof meta === 'object') {
    const cs = (meta as Record<string, unknown>).currentState;
    if (typeof cs === 'string' && cs.length > 0) return cs;
  }
  if (typeof o.currentState === 'string' && o.currentState.length > 0) return o.currentState;
  if (typeof o.state === 'string' && o.state.length > 0) return o.state;
  if (o.instance != null) {
    const inner = extractWorkflowCurrentState(o.instance);
    if (inner) return inner;
  }
  if (o.data != null) {
    const inner = extractWorkflowCurrentState(o.data);
    if (inner) return inner;
  }
  if (Array.isArray(o.items) && o.items.length > 0) {
    const inner = extractWorkflowCurrentState(o.items[0]);
    if (inner) return inner;
  }
  return '';
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export function Dashboard() {
  const { customerId, segment } = useCustomerContext();
  const navigate = useNavigate();
  const num = customerId ? customerNumber(customerId) : '001';
  const pmKey = `pm${num}`;
  const iaKey = `ia${num}`;

  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [rooms, setRooms] = useState<ChatRoomInstance[]>([]);
  const [loadingRes, setLoadingRes] = useState(true);
  const [loadingRooms, setLoadingRooms] = useState(true);
  const [messageLoading, setMessageLoading] = useState<string | null>(null);
  const [bookModal, setBookModal] = useState<{ advisorKey: string; advisorType: 'PM' | 'IA' } | null>(null);
  const [bookDate, setBookDate] = useState('');
  const [slots, setSlots] = useState<{ start: string; end: string }[]>([]);
  const [loadingSlots, setLoadingSlots] = useState(false);
  const [selectedSlot, setSelectedSlot] = useState<{ start: string; end: string } | null>(null);
  const [bookSaving, setBookSaving] = useState(false);
  const [editModal, setEditModal] = useState<ReservationInstance | null>(null);
  const [editDate, setEditDate] = useState('');
  const [editSlots, setEditSlots] = useState<{ start: string; end: string }[]>([]);
  const [editSelectedSlot, setEditSelectedSlot] = useState<{ start: string; end: string } | null>(null);
  const [editSlotsLoading, setEditSlotsLoading] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [cancelModal, setCancelModal] = useState<ReservationInstance | null>(null);
  const [cancelLoading, setCancelLoading] = useState(false);
  const [roomDetail, setRoomDetail] = useState<ChatRoomInstance | null>(null);
  const [roomMessages, setRoomMessages] = useState<RoomMessage[]>([]);
  const [roomMessagesLoading, setRoomMessagesLoading] = useState(false);
  const [startMeetLoading, setStartMeetLoading] = useState<string | null>(null);
  const [videoCallModal, setVideoCallModal] = useState<{
    reservation: ReservationInstance;
    status: 'starting' | 'waiting' | 'ready';
    videoUrl: string | null;
  } | null>(null);
  const [confirmReservation, setConfirmReservation] = useState<{ instanceId: string } | null>(null);
  const [confirmReservationSnapshot, setConfirmReservationSnapshot] = useState<{
    advisor: string;
    startDateTime: string;
    endDateTime: string;
  } | null>(null);
  const [confirmReservationPolling, setConfirmReservationPolling] = useState(false);
  const [confirmReservationTransitioning, setConfirmReservationTransitioning] = useState(false);
  const [reservationSuccessModalOpen, setReservationSuccessModalOpen] = useState(false);

  const fetchReservations = useCallback(async () => {
    if (!customerId) return;
    setLoadingRes(true);
    try {
      const res = await getReservations({ touchUser: customerId, userType: 'customer' });
      setReservations(extractReservations(res));
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoadingRes(false);
    }
  }, [customerId]);

  const fetchRooms = useCallback(async () => {
    if (!customerId) return;
    setLoadingRooms(true);
    try {
      const res = await getChatRooms({ touchUser: customerId, userType: 'customer' });
      const list = extractChatRooms(res);
      setRooms(list.filter((r) => (r.status ?? '') !== 'deactivated'));
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoadingRooms(false);
    }
  }, [customerId]);

  useEffect(() => {
    fetchReservations();
    fetchRooms();
  }, [fetchReservations, fetchRooms]);

  useEffect(() => {
    if (!videoCallModal || videoCallModal.status !== 'waiting' || !customerId) return;
    const r = videoCallModal.reservation;
    const id = r.id ?? r.key;
    let cancelled = false;

    const poll = async () => {
      try {
        const res = await getInstance('rezervation', id);
        if (cancelled) return;
        const data = res.data as { attributes?: { videoCallUrls?: Record<string, string>[] }; videoCallUrls?: Record<string, string>[] } | null;
        const urls = data?.attributes?.videoCallUrls ?? data?.videoCallUrls;
        if (urls && Array.isArray(urls) && urls.length > 0) {
          const myEntry = urls.find((u) => u && customerId in u);
          if (myEntry && myEntry[customerId]) {
            setVideoCallModal((prev) => prev ? { ...prev, status: 'ready', videoUrl: myEntry[customerId] } : null);
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
  }, [videoCallModal?.status, videoCallModal?.reservation.key, customerId]);

  useEffect(() => {
    const instanceId = confirmReservation?.instanceId;
    if (!instanceId) return;
    let cancelled = false;
    let attempts = 0;
    const maxAttempts = 45;
    const pollMs = 650;

    const tick = async () => {
      if (cancelled) return;
      attempts += 1;
      try {
        const res = await getInstance('rezervation', instanceId);
        if (cancelled) return;
        if (!res.ok) {
          if (attempts >= maxAttempts) {
            toast('Randevu bilgisi alınamadı.', 'error');
            setConfirmReservation(null);
            setConfirmReservationSnapshot(null);
            setConfirmReservationPolling(false);
            return;
          }
          setTimeout(tick, pollMs);
          return;
        }
        const d = res.data as Record<string, unknown> | null;
        const currentState = extractWorkflowCurrentState(d);
        const attrs = (d?.attributes ?? {}) as Record<string, unknown>;

        if (currentState === 'slot-unavailable') {
          toast('Bu slot artık müsait değil; lütfen başka bir slot seçin.', 'error');
          setConfirmReservation(null);
          setConfirmReservationSnapshot(null);
          setConfirmReservationPolling(false);
          return;
        }
        if (currentState === 'appointment-form') {
          setConfirmReservationSnapshot({
            advisor: String(attrs.advisor ?? ''),
            startDateTime: String(attrs.startDateTime ?? ''),
            endDateTime: String(attrs.endDateTime ?? ''),
          });
          setConfirmReservationPolling(false);
          return;
        }
        if (attempts >= maxAttempts) {
          toast('Randevu onayı için hazır olunamadı; lütfen tekrar deneyin.', 'error');
          setConfirmReservation(null);
          setConfirmReservationSnapshot(null);
          setConfirmReservationPolling(false);
          return;
        }
        setTimeout(tick, pollMs);
      } catch {
        if (cancelled) return;
        if (attempts >= maxAttempts) {
          toast('Randevu bilgisi alınamadı.', 'error');
          setConfirmReservation(null);
          setConfirmReservationSnapshot(null);
          setConfirmReservationPolling(false);
          return;
        }
        setTimeout(tick, pollMs);
      }
    };

    setConfirmReservationPolling(true);
    setConfirmReservationSnapshot(null);
    tick();
    return () => {
      cancelled = true;
    };
  }, [confirmReservation?.instanceId]);

  const closeConfirmReservationModal = () => {
    setConfirmReservation(null);
    setConfirmReservationSnapshot(null);
    setConfirmReservationPolling(false);
    setConfirmReservationTransitioning(false);
  };

  const handleConfirmReservationTransition = async () => {
    const instanceId = confirmReservation?.instanceId;
    if (!instanceId) return;
    setConfirmReservationTransitioning(true);
    try {
      const confirmRes = await runTransition('rezervation', instanceId, 'confirm-selection', {});
      if (!confirmRes.ok) {
        toast(
          String(
            (confirmRes.data as Record<string, unknown>)?.detail
              ?? (confirmRes.data as Record<string, unknown>)?.error
              ?? 'Onaylanamadı'
          ),
          'error'
        );
        return;
      }
      let stateStr = extractWorkflowCurrentState(confirmRes.data);
      if (stateStr === 'slot-unavailable') {
        toast('Bu slot artık müsait değil; lütfen başka bir slot seçin.', 'error');
        closeConfirmReservationModal();
        return;
      }
      if (stateStr !== 'active') {
        for (let i = 0; i < 14 && stateStr !== 'active' && stateStr !== 'slot-unavailable'; i += 1) {
          await delay(320);
          const gi = await getInstance('rezervation', instanceId);
          if (gi.ok && gi.data != null) {
            stateStr = extractWorkflowCurrentState(gi.data);
          }
        }
      }
      if (stateStr === 'slot-unavailable') {
        toast('Bu slot artık müsait değil; lütfen başka bir slot seçin.', 'error');
        closeConfirmReservationModal();
        return;
      }
      if (stateStr === 'active') {
        closeConfirmReservationModal();
        setReservationSuccessModalOpen(true);
        return;
      }
      // Geçiş başarılı ama yanıtta state yok / farklı şekilde: boş state veya okunamayan gövde → başarı kabul et
      if (stateStr === '') {
        closeConfirmReservationModal();
        setReservationSuccessModalOpen(true);
        return;
      }
      toast(
        String(
          (confirmRes.data as Record<string, unknown>)?.detail
            ?? (confirmRes.data as Record<string, unknown>)?.error
            ?? 'Randevu tamamlanamadı'
        ),
        'error'
      );
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setConfirmReservationTransitioning(false);
    }
  };

  const handleReservationSuccessAck = () => {
    setReservationSuccessModalOpen(false);
    void fetchReservations();
  };

  const activeReservations = reservations.filter((r) => {
    const s = r.metadata?.currentState ?? '';
    return s === 'active' || s === 'in-meet' || s === 'accept-terms' || s === 'can-start-meeting';
  });

  const now = Date.now();
  const fifteenMin = 15 * 60 * 1000;
  const upcomingSoon = activeReservations.filter((r) => {
    const start = r.attributes?.startDateTime;
    const end = r.attributes?.endDateTime;
    if (!start || !end) return false;
    const startTs = new Date(start).getTime();
    const endTs = new Date(end).getTime();
    return now >= startTs - fifteenMin && now <= endTs;
  });

  const reservationsByAdvisor = (advisorKey: string): ReservationInstance[] =>
    activeReservations.filter((r) => (r.attributes?.advisor ?? '').includes(advisorKey));

  const handleMessage = async (advisorKey: string, advisorType: 'PM' | 'IA') => {
    if (!customerId) return;
    setMessageLoading(advisorKey);
    try {
      const res = await startInstance('start-chat', {
        key: `${customerId}-${advisorType}`,
        tags: ['chat', 'start-chat'],
        attributes: { user: customerId, advisorType, advisorId: advisorKey },
      });
      if (res.ok) {
        toast('Mesaj oturumu başlatıldı', 'success');
        navigate('/customer/chat', { state: { openAdvisorKey: advisorKey } });
      } else {
        const err = (res.data as Record<string, unknown>)?.error ?? 'Mesaj başlatılamadı';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setMessageLoading(null);
    }
  };

  const handleStartMeet = async (r: ReservationInstance) => {
    if (!r.key) return;
    setStartMeetLoading(r.key);
    setVideoCallModal({ reservation: r, status: 'starting', videoUrl: null });
    try {
      const res = await startInstance('rezervation-start', {
        key: `rezervation-start-${Date.now()}`,
        tags: ['rezervation-start'],
        attributes: { randevuKey: r.key, participantType: 'customer' },
      });
      if (res.ok) {
        setVideoCallModal((prev) => prev ? { ...prev, status: 'waiting' } : null);
        fetchReservations();
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

  const openBookModal = (advisorKey: string, advisorType: 'PM' | 'IA') => {
    setBookModal({ advisorKey, advisorType });
    setBookDate('');
    setSlots([]);
    setSelectedSlot(null);
  };

  const loadSlots = async () => {
    if (!bookModal || !bookDate) return;
    setLoadingSlots(true);
    try {
      const res = await getAvailableSlots(bookModal.advisorKey, bookDate, '30');
      setSlots(extractSlotItems(res));
      setSelectedSlot(null);
    } catch {
      setSlots([]);
    } finally {
      setLoadingSlots(false);
    }
  };

  useEffect(() => {
    if (bookDate && bookModal) loadSlots();
  }, [bookDate, bookModal?.advisorKey]);

  const openEditModal = (r: ReservationInstance) => {
    const start = r.attributes?.startDateTime ?? '';
    const end = r.attributes?.endDateTime ?? '';
    const datePart = start.split('T')[0] ?? '';
    const startTime = start.includes('T') ? start.split('T')[1]?.slice(0, 5) ?? '' : '';
    const endTime = end.includes('T') ? end.split('T')[1]?.slice(0, 5) ?? '' : '';
    setEditModal(r);
    setEditDate(datePart);
    setEditSelectedSlot(startTime && endTime ? { start: startTime, end: endTime } : null);
    setEditSlots([]);
  };

  const loadEditSlots = useCallback(async () => {
    if (!editModal?.attributes?.advisor || !editDate) return;
    setEditSlotsLoading(true);
    try {
      const res = await getAvailableSlots(editModal.attributes.advisor, editDate, '30');
      const items = extractSlotItems(res);
      setEditSlots(items);
      setEditSelectedSlot((prev) => {
        if (!prev) return null;
        const match = items.find((s) => s.start === prev.start && s.end === prev.end);
        return match ?? null;
      });
    } catch {
      setEditSlots([]);
      setEditSelectedSlot(null);
    } finally {
      setEditSlotsLoading(false);
    }
  }, [editModal?.attributes?.advisor, editDate]);

  useEffect(() => {
    if (editDate && editModal) loadEditSlots();
  }, [editDate, editModal?.key, loadEditSlots]);

  const handleBook = async () => {
    if (!customerId || !bookModal || !selectedSlot) return;
    setBookSaving(true);
    try {
      const key = `rez-${customerId}-${Date.now()}`;
      const startDateTime = toUtcIsoFromDateAndTime(bookDate, selectedSlot.start);
      const endDateTime = toUtcIsoFromDateAndTime(bookDate, selectedSlot.end);
      const startRes = await startInstance(
        'rezervation',
        {
          key,
          tags: ['appointment', 'randevu'],
          attributes: {
            user: customerId,
            advisor: bookModal.advisorKey,
            startDateTime,
            endDateTime,
          },
        },
        { sub: customerId }
      );
      if (!startRes.ok) {
        toast(String((startRes.data as Record<string, unknown>)?.error ?? 'Randevu oluşturulamadı'), 'error');
        return;
      }
      const instId = (startRes.data as { id?: string })?.id;
      if (!instId) {
        toast('Randevu oluşturuldu; onay için danışman ile iletişime geçin.', 'success');
        setBookModal(null);
        setBookDate('');
        setSlots([]);
        setSelectedSlot(null);
        fetchReservations();
        return;
      }
      setBookModal(null);
      setBookDate('');
      setSlots([]);
      setSelectedSlot(null);
      setConfirmReservationSnapshot(null);
      setConfirmReservationPolling(true);
      setConfirmReservation({ instanceId: instId });
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setBookSaving(false);
    }
  };

  const handleEditReservation = async () => {
    if (!editModal || !editSelectedSlot || !editDate) return;
    setEditSaving(true);
    try {
      const advisor = editModal.attributes?.advisor ?? '';
      const startDateTime = toUtcIsoFromDateAndTime(editDate, editSelectedSlot.start);
      const endDateTime = toUtcIsoFromDateAndTime(editDate, editSelectedSlot.end);

      const startRes = await startInstance('rezervation-update', {
        key: `randevu-update-${Date.now()}`,
        tags: ['rezervation-update'],
        attributes: { randevuKey: editModal.key },
      });

      if (!startRes.ok) {
        toast(String((startRes.data as Record<string, unknown>)?.error ?? 'Güncelleme başlatılamadı'), 'error');
        return;
      }
      const instId = (startRes.data as { id?: string })?.id;
      if (!instId) {
        toast('Güncelleme başlatıldı.', 'success');
        setEditModal(null);
        fetchReservations();
        return;
      }

      const transRes = await runTransition('rezervation-update', instId, 'to-validate', {
        startDateTime,
        endDateTime,
        advisor,
      });

      if (transRes.ok) {
        toast('Randevu güncellendi', 'success');
        setEditModal(null);
        fetchReservations();
      } else {
        const err = (transRes.data as Record<string, unknown>)?.error ?? (transRes.data as Record<string, unknown>)?.detail ?? 'Slot uygun değil';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setEditSaving(false);
    }
  };

  const handleCancelReservation = async () => {
    if (!cancelModal?.id) return;
    setCancelLoading(true);
    try {
      const res = await runTransition('rezervation', cancelModal.id, 'user-cancel', {});
      if (res.ok) {
        toast('Randevu iptal edildi', 'success');
        setCancelModal(null);
        fetchReservations();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'İptal edilemedi'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setCancelLoading(false);
    }
  };

  const openRoomDetail = async (room: ChatRoomInstance) => {
    setRoomDetail(room);
    const roomId = room.roomId;
    if (!roomId || !customerId) {
      setRoomMessages([]);
      return;
    }
    setRoomMessagesLoading(true);
    try {
      const res = await getRoomMessages(
        { limit: '50', pageSize: '1' },
        { roomId, touchUser: customerId }
      );
      const d = res.data as Record<string, unknown>;
      const topItems = d?.items as Array<{ getRoomMessages?: { messages?: RoomMessage[] } }> | undefined;
      let list: RoomMessage[] = [];
      if (Array.isArray(topItems) && topItems.length > 0) {
        const msgs = topItems.flatMap((it) => it?.getRoomMessages?.messages ?? []);
        if (msgs.length > 0) list = msgs;
      }
      if (list.length === 0) {
        const nested = d?.getRoomMessages as { messages?: RoomMessage[] } | undefined;
        list = (d?.messages as RoomMessage[] | undefined) ?? nested?.messages ?? [];
      }
      const customerMatrixId = `@${customerId}:localhost`;
      const msgs = [...(Array.isArray(list) ? list : [])].reverse().map((m) => ({
        ...m,
        isMine: (m.sender ?? '').includes(customerId) || (m.sender ?? '') === customerMatrixId,
      }));
      setRoomMessages(msgs);
    } catch {
      setRoomMessages([]);
    } finally {
      setRoomMessagesLoading(false);
    }
  };

  const advisors = [
    { key: pmKey, type: 'PM' as const, label: 'Portföy Yöneticisi', Icon: Briefcase },
    { key: iaKey, type: 'IA' as const, label: 'Yatırım Danışmanı', Icon: TrendingUp },
  ];

  const isPrivatePlus = segment === 'Private Plus';

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard</h1>
      </div>
      <div className="page-grid page-grid-full">
        {/* Finansal Rehberleriniz */}
        <Card>
          <CardHeader>
            <h3>Finansal Rehberleriniz</h3>
          </CardHeader>
          <CardBody>
            <div className="flex gap-4" style={{ flexWrap: 'wrap' }}>
              {advisors.map(({ key, type, label, Icon }) => {
                const revs = reservationsByAdvisor(key);
                return (
                  <div key={key} className="card p-4" style={{ minWidth: 280, maxWidth: 360 }}>
                    <div className="flex items-center gap-2 mb-3">
                      <Icon size={24} />
                      <span className="font-medium">{label}</span>
                      <span className="text-muted text-sm">{key.split('.').pop()}</span>
                    </div>
                    <div className="flex flex-col gap-2 mb-3">
                      <button
                        className="btn btn-primary btn-sm"
                        disabled={messageLoading === key}
                        onClick={() => handleMessage(key, type)}
                      >
                        {messageLoading === key ? <RefreshCw size={14} className="animate-spin" /> : <MessageSquare size={14} />}
                        Mesaj
                      </button>
                      {isPrivatePlus && (
                        <button
                          className="btn btn-secondary btn-sm"
                          disabled={revs.length >= 2}
                          onClick={() => openBookModal(key, type)}
                        >
                          <CalendarDays size={14} />
                          Randevu Al
                        </button>
                      )}
                    </div>
                    {revs.length > 0 && (
                      <div className="border-t pt-2 mt-2">
                        <p className="text-sm font-medium text-muted mb-1">Randevularım</p>
                        <ul className="space-y-1">
                          {revs.map((r, idx) => {
                            const canEdit = (r.metadata?.currentState ?? '') === 'active';
                            return (
                            <li key={r.key ?? r.id ?? `rev-${idx}`} className="flex items-center justify-between gap-2 text-sm">
                              <span>
                                {formatDateTime(r.attributes?.startDateTime ?? '')} – {formatTime(r.attributes?.endDateTime ?? '')}
                              </span>
                              <span className="flex gap-1">
                                <button
                                  type="button"
                                  className="btn btn-secondary btn-xs"
                                  disabled={!canEdit}
                                  onClick={() => openEditModal(r)}
                                  title={canEdit ? 'Düzenle' : 'Sadece aktif randevular düzenlenebilir'}
                                >
                                  <Pencil size={12} />
                                </button>
                                <button
                                  type="button"
                                  className="btn btn-danger btn-xs"
                                  onClick={() => setCancelModal(r)}
                                  title="İptal"
                                >
                                  <Trash2 size={12} />
                                </button>
                              </span>
                            </li>
                          );
                          })}
                        </ul>
                      </div>
                    )}
                    {revs.length >= 2 && (
                      <div
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 8,
                          padding: '8px 12px',
                          borderRadius: 'var(--radius)',
                          backgroundColor: 'var(--color-warning-bg, #fff3cd)',
                          border: '1px solid var(--color-warning-border, #ffc107)',
                          color: 'var(--color-warning-text, #856404)',
                          fontSize: 13,
                          marginTop: 8,
                        }}
                      >
                        <Info size={16} />
                        <span>2&apos;den fazla randevu alamazsınız</span>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          </CardBody>
        </Card>

        {isPrivatePlus && (
          <>
            {/* Yaklaşan Randevu */}
            <Card>
              <CardHeader>
                <h3>Yaklaşan Randevu</h3>
              </CardHeader>
              <CardBody>
                {loadingRes ? (
                  <div className="empty-state">
                    <RefreshCw size={32} className="animate-spin" />
                    <p>Yükleniyor...</p>
                  </div>
                ) : upcomingSoon.length === 0 ? (
                  <EmptyState message="15 dakika içinde başlayacak randevu yok" icon={<Clock size={40} strokeWidth={1.5} />} />
                ) : (
                  <ul className="space-y-2">
                    {upcomingSoon.map((r, idx) => (
                      <li key={r.key ?? r.id ?? `up-${idx}`} className="flex items-center justify-between p-2 rounded border">
                        <span>
                          {formatDateTime(r.attributes?.startDateTime ?? '')} – {r.attributes?.advisor ?? ''}
                        </span>
                        <button
                          className="btn btn-primary btn-sm"
                          disabled={startMeetLoading === r.key}
                          onClick={() => handleStartMeet(r)}
                        >
                          {startMeetLoading === r.key ? <RefreshCw size={14} className="animate-spin" /> : <Video size={14} />}
                          Görüntülü görüşmeye başla
                        </button>
                      </li>
                    ))}
                  </ul>
                )}
              </CardBody>
            </Card>

            {/* Geçmiş Görüşmelerim */}
            <Card>
              <CardHeader>
                <h3>Geçmiş Görüşmelerim</h3>
              </CardHeader>
              <CardBody>
                {loadingRooms ? (
                  <div className="empty-state">
                    <RefreshCw size={32} className="animate-spin" />
                    <p>Yükleniyor...</p>
                  </div>
                ) : rooms.length === 0 ? (
                  <EmptyState message="Henüz görüşme yok" icon={<MessageSquare size={40} strokeWidth={1.5} />} />
                ) : (
                  <div className="table-wrapper">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Tip</th>
                          <th>Danışman / Danışmanlar</th>
                          <th>Tarih / Saat</th>
                          <th></th>
                        </tr>
                      </thead>
                      <tbody>
                        {rooms.map((room, idx) => (
                          <tr key={room.instanceKey ?? `room-${idx}`}>
                            <td>{getRoomTypeLabel(room.roomType)}</td>
                            <td>{getRoomAdvisors(room)}</td>
                            <td>{getRoomDateDisplay(room)}</td>
                            <td>
                              <button
                                type="button"
                                className="btn btn-secondary btn-sm"
                                onClick={() => openRoomDetail(room)}
                              >
                                Detay <ChevronRight size={14} />
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
          </>
        )}
      </div>

      {/* Randevu Al modal */}
      <Modal
        open={!!bookModal}
        onClose={() => setBookModal(null)}
        title="Randevu Al"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setBookModal(null)}>İptal</button>
            <button
              className="btn btn-primary"
              disabled={!selectedSlot || bookSaving}
              onClick={handleBook}
            >
              {bookSaving ? <RefreshCw size={16} className="animate-spin" /> : 'Randevu Al'}
            </button>
          </>
        }
      >
        {bookModal && (
          <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <div className="form-group">
              <label className="form-label">Tarih</label>
              <input
                type="date"
                className="form-input"
                value={bookDate}
                onChange={(e) => setBookDate(e.target.value)}
              />
            </div>
            {bookDate && (
              <div className="form-group" style={{ flex: '1 1 100%' }}>
                <label className="form-label">Saat (müsait slotlar)</label>
                {loadingSlots ? (
                  <p>Yükleniyor...</p>
                ) : slots.length === 0 ? (
                  <p className="text-muted">Bu tarihte müsait slot yok.</p>
                ) : (
                  <select
                    className="form-input"
                    value={selectedSlot ? `${selectedSlot.start}-${selectedSlot.end}` : ''}
                    onChange={(e) => {
                      const slotKey = e.target.value;
                      const slot = slots.find((s) => `${s.start}-${s.end}` === slotKey);
                      setSelectedSlot(slot ?? null);
                    }}
                  >
                    <option value="">Slot seçin</option>
                    {slots.map((slot, idx) => (
                      <option
                        key={slot.start && slot.end ? `${slot.start}-${slot.end}` : `slot-${idx}`}
                        value={`${slot.start}-${slot.end}`}
                      >
                        {slot.start} – {slot.end}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Randevu özeti ve onay (confirm-selection) */}
      <Modal
        open={!!confirmReservation}
        onClose={closeConfirmReservationModal}
        title="Randevu özeti"
        footer={
          <>
            <button type="button" className="btn btn-secondary" onClick={closeConfirmReservationModal}>
              İptal
            </button>
            <button
              type="button"
              className="btn btn-primary"
              disabled={
                confirmReservationPolling
                || !confirmReservationSnapshot
                || confirmReservationTransitioning
              }
              onClick={() => void handleConfirmReservationTransition()}
            >
              {confirmReservationTransitioning ? (
                <RefreshCw size={16} className="animate-spin" />
              ) : (
                'Onayla'
              )}
            </button>
          </>
        }
      >
        {confirmReservationPolling && !confirmReservationSnapshot && (
          <div style={{ textAlign: 'center', padding: 24 }}>
            <RefreshCw size={28} className="animate-spin" style={{ margin: '0 auto 12px', display: 'block' }} />
            <p className="text-muted">Randevu bilgileri yükleniyor…</p>
          </div>
        )}
        {confirmReservationSnapshot && (
          <div
            className="form-row"
            style={{ flexDirection: 'column', gap: 12, alignItems: 'flex-start' }}
          >
            <p>
              <span className="text-muted">Danışman</span>
              <br />
              <strong>{confirmReservationSnapshot.advisor || '—'}</strong>
            </p>
            <p>
              <span className="text-muted">Başlangıç</span>
              <br />
              <strong>{formatDateTime(confirmReservationSnapshot.startDateTime) || '—'}</strong>
            </p>
            <p>
              <span className="text-muted">Bitiş</span>
              <br />
              <strong>{formatDateTime(confirmReservationSnapshot.endDateTime) || '—'}</strong>
            </p>
          </div>
        )}
      </Modal>

      <Modal
        open={reservationSuccessModalOpen}
        onClose={handleReservationSuccessAck}
        title="Randevu"
        footer={
          <button type="button" className="btn btn-primary" onClick={handleReservationSuccessAck}>
            Tamam
          </button>
        }
      >
        <p style={{ margin: 0 }}>
          Randevunuz oluşturuldu.
          <br />
          <span className="text-muted" style={{ fontSize: 14 }}>Randevunuz başarılı şekilde kaydedildi.</span>
        </p>
      </Modal>

      {/* Randevu Düzenle */}
      <Modal
        open={!!editModal}
        onClose={() => { setEditModal(null); setEditDate(''); setEditSlots([]); setEditSelectedSlot(null); }}
        title="Randevu Düzenle"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setEditModal(null)}>Vazgeç</button>
            <button
              className="btn btn-primary"
              disabled={!editSelectedSlot || editSaving}
              onClick={handleEditReservation}
            >
              {editSaving ? <RefreshCw size={16} className="animate-spin" /> : 'Güncelle'}
            </button>
          </>
        }
      >
        {editModal && (
          <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
            <div className="form-group">
              <label className="form-label">Tarih</label>
              <input
                type="date"
                className="form-input"
                value={editDate}
                onChange={(e) => setEditDate(e.target.value)}
              />
            </div>
            {editDate && (
              <div className="form-group" style={{ flex: '1 1 100%' }}>
                <label className="form-label">Saat (müsait slotlar)</label>
                {editSlotsLoading ? (
                  <p>Yükleniyor...</p>
                ) : editSlots.length === 0 ? (
                  <p className="text-muted">Bu tarihte müsait slot yok.</p>
                ) : (
                  <select
                    className="form-input"
                    value={editSelectedSlot ? `${editSelectedSlot.start}-${editSelectedSlot.end}` : ''}
                    onChange={(e) => {
                      const slotKey = e.target.value;
                      const slot = editSlots.find((s) => `${s.start}-${s.end}` === slotKey);
                      setEditSelectedSlot(slot ?? null);
                    }}
                  >
                    <option value="">Slot seçin</option>
                    {editSlots.map((slot, idx) => (
                      <option
                        key={slot.start && slot.end ? `${slot.start}-${slot.end}` : `edit-slot-${idx}`}
                        value={`${slot.start}-${slot.end}`}
                      >
                        {slot.start} – {slot.end}
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* İptal onay */}
      <Modal
        open={!!cancelModal}
        onClose={() => setCancelModal(null)}
        title="Randevuyu İptal Et"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setCancelModal(null)}>Vazgeç</button>
            <button className="btn btn-danger" disabled={cancelLoading} onClick={handleCancelReservation}>
              {cancelLoading ? <RefreshCw size={16} className="animate-spin" /> : 'İptal Et'}
            </button>
          </>
        }
      >
        {cancelModal && (
          <p>
            <strong>{formatDateTime(cancelModal.attributes?.startDateTime ?? '')}</strong> tarihli randevuyu iptal etmek istediğinize emin misiniz?
          </p>
        )}
      </Modal>

      {/* Oda detay / mesajlar */}
      <Modal
        open={!!roomDetail}
        onClose={() => { setRoomDetail(null); setRoomMessages([]); }}
        title={roomDetail ? `${getRoomTypeLabel(roomDetail.roomType)} – ${getRoomAdvisors(roomDetail)}` : 'Oda'}
        footer={null}
      >
        {roomDetail && (
          <div>
            {roomMessagesLoading ? (
              <p>Mesajlar yükleniyor...</p>
            ) : (
              <div className="chat-messages" style={{ maxHeight: 400 }}>
                {roomMessages.length === 0 ? (
                  <p className="text-muted">Henüz mesaj yok.</p>
                ) : (
                  Object.entries(groupMessagesByDate(roomMessages)).map(([date, msgs]) => (
                    <Fragment key={date}>
                      <div className="chat-date-divider">{date}</div>
                      {msgs.map((m, i) => (
                        <div
                          key={m.eventId ?? i}
                          className={cn('chat-msg', m.isMine ? 'mine' : 'theirs')}
                        >
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
              </div>
            )}
          </div>
        )}
      </Modal>

      {/* Video call modal */}
      <Modal
        open={!!videoCallModal}
        onClose={() => setVideoCallModal(null)}
        title="Görüntülü Görüşme"
        footer={
          videoCallModal?.status === 'ready' ? (
            <>
              <button className="btn btn-secondary" onClick={() => setVideoCallModal(null)}>Kapat</button>
              <a href={videoCallModal.videoUrl!} target="_blank" rel="noreferrer" className="btn btn-primary">
                <Video size={16} /> Görüşmeye Katıl
              </a>
            </>
          ) : (
            <button className="btn btn-secondary" onClick={() => setVideoCallModal(null)}>İptal</button>
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
            <p style={{ fontWeight: 600, fontSize: 16, marginBottom: 8 }}>
              Danışmanınıza bildirim gönderildi
            </p>
            <p className="text-muted">
              Onay verdiğinde görüntülü görüşmeniz başlayacaktır.
            </p>
            <RefreshCw size={20} className="animate-spin" style={{ margin: '16px auto 0', display: 'block', color: 'var(--color-muted)' }} />
          </div>
        )}
        {videoCallModal?.status === 'ready' && (
          <div style={{ textAlign: 'center', padding: 32 }}>
            <Video size={48} strokeWidth={1.5} style={{ margin: '0 auto 16px', display: 'block', color: 'var(--color-success, #16a34a)' }} />
            <p style={{ fontWeight: 600, fontSize: 16 }}>Görüntülü görüşme hazır!</p>
            <p className="text-muted">Görüşmeye katılmak için aşağıdaki butonu kullanın.</p>
          </div>
        )}
      </Modal>
    </div>
  );
}
