import { useEffect, useState, useCallback } from 'react';
import {
  CalendarDays,
  MessageSquare,
  RefreshCw,
  Clock,
} from 'lucide-react';
import { getReservations, getChatRooms } from '../../lib/api';
import { formatTime, timeUntil } from '../../lib/utils';
import { toast } from '../../components/ui';
import { useAdvisorContext } from '../../contexts/AdvisorContext';

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

function extractItems<T>(res: { ok: boolean; data?: unknown }, ...keys: string[]): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as Record<string, unknown>;
  let data: Record<string, unknown> = d;
  for (const k of keys) {
    if (d[k] && typeof d[k] === 'object') data = d[k] as Record<string, unknown>;
  }
  const items = (data?.items as T[]) ?? [];
  return Array.isArray(items) ? items : [];
}

export function Dashboard() {
  const ADVISOR_ID = useAdvisorContext().advisorId!;
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<VnextInstance[]>([]);
  const [chatRooms, setChatRooms] = useState<VnextInstance[]>([]);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const [rezRes, chatRes] = await Promise.all([
        getReservations({}, { touchUser: ADVISOR_ID, userType: 'advisor' }),
        getChatRooms({ pageSize: '1' }, { touchUser: ADVISOR_ID, userType: 'advisor' }),
      ]);

      const rezItems = extractItems<VnextInstance>(rezRes, 'getRezervations', 'get-rezervations');
      const chatItems = extractItems<VnextInstance>(chatRes, 'getChatRooms', 'get-chat-rooms');

      setReservations(rezItems);
      setChatRooms(chatItems);
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, [ADVISOR_ID]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const today = new Date().toISOString().slice(0, 10);
  const todayReservations = reservations
    .filter((r) => (r.attributes?.startDateTime as string)?.startsWith?.(today))
    .sort((a, b) =>
      String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''))
    );

  const nextMeeting = todayReservations.find(
    (r) =>
      (r.metadata?.currentState === 'active' || r.metadata?.currentState === 'in-meet') &&
      new Date(r.attributes?.endDateTime as string).getTime() > Date.now()
  ) ?? todayReservations.find((r) => new Date(r.attributes?.startDateTime as string).getTime() > Date.now());

  const activeChats = chatRooms.filter((c) => {
    const st = c.metadata?.currentState;
    return st !== 'deactivated' && st !== 'complete' && st !== 'completed';
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>Dashboard — Günlük İş Takibi</h1>
        <button
          className="btn btn-secondary btn-sm"
          onClick={fetchData}
          disabled={loading}
          title="Yenile"
        >
          <RefreshCw size={16} className={loading ? 'animate-spin' : ''} />
          Yenile
        </button>
      </div>

      {loading ? (
        <div className="empty-state">
          <RefreshCw size={40} className="animate-pulse" />
          <p>Veriler yükleniyor...</p>
        </div>
      ) : (
        <>
          {/* Summary stats row */}
          <div className="page-grid">
            <div className="card">
              <div className="card-header">
                <CalendarDays size={20} />
                <h3>Günün Randevuları</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{todayReservations.length}</p>
                <p className="text-muted text-sm">randevu</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <MessageSquare size={20} />
                <h3>Aktif Chatler</h3>
              </div>
              <div className="card-body">
                <p className="card-stat">{activeChats.length}</p>
                <p className="text-muted text-sm">açık chat</p>
              </div>
            </div>

            <div className="card">
              <div className="card-header">
                <Clock size={20} />
                <h3>Yaklaşan Görüşme</h3>
              </div>
              <div className="card-body">
                {nextMeeting ? (
                  <>
                    <p className="card-stat text-sm font-normal">
                      {formatTime(nextMeeting.attributes?.startDateTime as string)} -{' '}
                      {formatTime(nextMeeting.attributes?.endDateTime as string)}
                    </p>
                    <p className="text-muted text-sm">{timeUntil(nextMeeting.attributes?.startDateTime as string)}</p>
                  </>
                ) : (
                  <p className="text-muted text-sm">Yaklaşan görüşme yok</p>
                )}
              </div>
            </div>

          </div>

        </>
      )}
    </div>
  );
}
