import { useEffect, useState, useCallback } from 'react';
import {
  Video,
  VideoOff,
  MicOff,
  PhoneOff,
  Maximize2,
  Minimize2,
  Users,
  Scan,
  Pause,
  Play,
} from 'lucide-react';
import { Track } from 'livekit-client';
import {
  LiveKitRoom,
  VideoTrack,
  TrackToggle,
  RoomAudioRenderer,
  useTracks,
  useLocalParticipant,
} from '@livekit/components-react';
import '@livekit/components-styles';
import { BackgroundBlur, supportsBackgroundProcessors } from '@livekit/track-processors';
import { getReservations, callFunction } from '../../lib/api';
import { formatTime, cn } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';
import { useAdvisorContext } from '../../contexts/AdvisorContext';

const LIVEKIT_SERVER_URL = 'ws://localhost:7881';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: string;
    advisor?: string;
    startDateTime?: string;
    endDateTime?: string;
    webrtcIntegration?: { livekit?: { room?: string } };
    chatIntegration?: { matrix?: { roomId?: string } };
  };
  metadata?: { currentState?: string };
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function userName(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function getRoomName(r: ReservationInstance): string | undefined {
  return r.attributes?.webrtcIntegration?.livekit?.room;
}

function canJoin(r: ReservationInstance): boolean {
  const s = r.metadata?.currentState ?? '';
  return s === 'active' || s === 'in-meet';
}

/* --- Video Call Controls (inside LiveKitRoom) --- */
function VideoCallControls({
  onMinimize,
  onAddParticipant,
  onEndCall,
}: {
  onMinimize: () => void;
  onAddParticipant: () => void;
  onEndCall: () => void;
}) {
  const [blurEnabled, setBlurEnabled] = useState(false);
  const [holdEnabled, setHoldEnabled] = useState(false);
  const { localParticipant } = useLocalParticipant();

  const toggleBlur = useCallback(async () => {
    if (!supportsBackgroundProcessors()) {
      toast('Arka plan bulanıklaştırma bu tarayıcıda desteklenmiyor', 'error');
      return;
    }
    try {
      const camPub = localParticipant.getTrackPublication(Track.Source.Camera);
      const track = camPub?.track;
      if (!track) return;
      const videoTrack = track as import('livekit-client').LocalVideoTrack;
      if (blurEnabled) {
        await videoTrack.stopProcessor();
      } else {
        const processor = BackgroundBlur(10);
        await videoTrack.setProcessor(processor);
      }
      setBlurEnabled(!blurEnabled);
    } catch (e) {
      toast(String(e), 'error');
    }
  }, [blurEnabled, localParticipant]);

  return (
    <div className="video-controls">
      <TrackToggle
        source={Track.Source.Camera}
        className={cn('video-controls', 'btn')}
        title="Kamera"
      />
      <TrackToggle
        source={Track.Source.Microphone}
        className={cn('video-controls', 'btn')}
        title="Mikrofon"
      />
      <button
        type="button"
        className={holdEnabled ? 'active' : 'inactive'}
        onClick={() => setHoldEnabled(!holdEnabled)}
        title={holdEnabled ? 'Beklemeye al (kaldır)' : 'Beklemeye al'}
      >
        {holdEnabled ? <Play size={18} /> : <Pause size={18} />}
      </button>
      <button
        type="button"
        className="inactive"
        onClick={onMinimize}
        title="Küçült (PiP)"
      >
        <Minimize2 size={18} />
      </button>
      <TrackToggle
        source={Track.Source.ScreenShare}
        className={cn('video-controls', 'btn')}
        title="Ekran paylaşımı"
      />
      <button
        type="button"
        className={blurEnabled ? 'active' : 'inactive'}
        onClick={toggleBlur}
        title="Arka plan bulanıklaştırma"
      >
        <Scan size={18} />
      </button>
      <button
        type="button"
        className="inactive"
        onClick={onAddParticipant}
        title="Katılımcı ekle (konferans)"
      >
        <Users size={18} />
      </button>
      <button
        type="button"
        className="inactive"
        onClick={() => {}}
        title="Tam ekran"
      >
        <Maximize2 size={18} />
      </button>
      <button
        type="button"
        className="end-call"
        onClick={onEndCall}
        title="Görüşmeyi bitir"
      >
        <PhoneOff size={20} />
      </button>
    </div>
  );
}

/* --- Customer video area (remote participants) --- */
function CustomerVideoArea() {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);

  return (
    <div className="video-call-main" style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', position: 'relative' }}>
        {tracks.length > 0 ? (
          (() => {
            const screenShare = tracks.find((t) => t.source === Track.Source.ScreenShare);
            const mainTrack = screenShare ?? tracks[0];
            return (
              <div style={{ width: '100%', height: '100%' }}>
                <VideoTrack trackRef={mainTrack} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
              </div>
            );
          })()
        ) : (
          <div className="empty-state" style={{ color: '#94a3b8' }}>
            <Video size={48} strokeWidth={1.5} />
            <p>Müşteri video akışı bekleniyor</p>
          </div>
        )}
      </div>
    </div>
  );
}

/* --- Active Video Call Screen --- */
function ActiveVideoCall({
  reservation,
  token,
  onBack,
  onMinimize,
}: {
  reservation: ReservationInstance;
  token: string;
  onBack: () => void;
  onMinimize: () => void;
}) {
  const [addParticipantOpen, setAddParticipantOpen] = useState(false);
  const customerName = userName(reservation.attributes?.user);

  const handleDisconnect = useCallback(() => {
    onBack();
  }, [onBack]);

  return (
    <>
      <LiveKitRoom
        serverUrl={LIVEKIT_SERVER_URL}
        token={token}
        connect={true}
        video={true}
        audio={true}
        onDisconnected={handleDisconnect}
        onError={(err) => toast(err.message, 'error')}
        style={{ display: 'flex', flexDirection: 'column', height: '100%' }}
      >
        <RoomAudioRenderer />
        <div className="video-call-container">
          <div className="video-call-main">
            <CustomerVideoArea />
            <VideoCallControls
              onMinimize={onMinimize}
              onAddParticipant={() => setAddParticipantOpen(true)}
              onEndCall={handleDisconnect}
            />
          </div>
          <aside className="video-call-sidebar">
            <Card>
              <CardHeader>
                <h3>Müşteri Bilgileri</h3>
              </CardHeader>
              <CardBody>
                <p className="font-medium">{customerName}</p>
                <p className="text-muted text-sm mt-2">Segment: —</p>
                <div className="legal-notice mt-3">
                  Müşteriye okunması gereken yasal uyarılar burada yer alacaktır.
                </div>
                <button
                  type="button"
                  className="btn btn-secondary btn-sm mt-3"
                  disabled
                  title="Plan dahilinde değil"
                >
                  Memo Ekle
                </button>
              </CardBody>
            </Card>
          </aside>
        </div>
      </LiveKitRoom>

      <Modal
        open={addParticipantOpen}
        onClose={() => setAddParticipantOpen(false)}
        title="Katılımcı Ekle (Konferans)"
        footer={
          <button type="button" className="btn btn-primary" onClick={() => setAddParticipantOpen(false)}>
            Kapat
          </button>
        }
      >
        <p className="text-muted text-sm">Konferans katılımcı ekleme özelliği plan dahilinde.</p>
      </Modal>
    </>
  );
}

/* --- Fallback when no token --- */
function VideoCallFallback({
  reservation,
  onBack,
}: {
  reservation: ReservationInstance;
  onBack: () => void;
}) {
  const customerName = userName(reservation.attributes?.user);

  return (
    <div className="video-call-container">
      <div className="video-call-main">
        <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#0f172a' }}>
          <div className="empty-state" style={{ color: '#94a3b8' }}>
            <Video size={48} strokeWidth={1.5} />
            <p>Bağlantı kurulamadı</p>
            <p className="text-sm">LiveKit sunucusu çalışmıyor olabilir veya token alınamadı.</p>
            <button type="button" className="btn btn-secondary mt-3" onClick={onBack}>
              Listeye Dön
            </button>
          </div>
        </div>
        <div className="video-controls">
          <button type="button" className="inactive" disabled title="Kamera">
            <VideoOff size={18} />
          </button>
          <button type="button" className="inactive" disabled title="Mikrofon">
            <MicOff size={18} />
          </button>
          <button type="button" className="end-call" onClick={onBack}>
            <PhoneOff size={20} />
          </button>
        </div>
      </div>
      <aside className="video-call-sidebar">
        <Card>
          <CardHeader>
            <h3>Müşteri Bilgileri</h3>
          </CardHeader>
          <CardBody>
            <p className="font-medium">{customerName}</p>
            <p className="text-muted text-sm mt-2">Segment: —</p>
            <div className="legal-notice mt-3">
              Müşteriye okunması gereken yasal uyarılar burada yer alacaktır.
            </div>
            <button type="button" className="btn btn-secondary btn-sm mt-3" disabled>
              Memo Ekle
            </button>
          </CardBody>
        </Card>
      </aside>
    </div>
  );
}

/* --- PiP Bubble --- */
function PiPBubble({ onExpand }: { onExpand: () => void }) {
  return (
    <div className="pip-bubble" onClick={onExpand} role="button" tabIndex={0} onKeyDown={(e) => e.key === 'Enter' && onExpand()}>
      <Video size={24} />
      <span>Görüşme devam ediyor</span>
      <span className="text-muted text-sm">Tıklayarak büyüt</span>
    </div>
  );
}

/* --- Main Page --- */
export function VideoCalls() {
  const ADVISOR_ID = useAdvisorContext().advisorId!;
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [activeCall, setActiveCall] = useState<{
    reservation: ReservationInstance;
    token: string | null;
  } | null>(null);
  const [tokenLoading, setTokenLoading] = useState(false);
  const [pipMode, setPipMode] = useState(false);

  const fetchReservations = useCallback(async () => {
    setLoading(true);
    try {
      const res = await getReservations({ touchUser: ADVISOR_ID, userType: 'advisor' });
      const items = extractItems<ReservationInstance>(res);
      setReservations(items);
      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, [ADVISOR_ID]);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  const handleJoin = async (r: ReservationInstance) => {
    const roomName = getRoomName(r);
    if (!roomName) {
      toast('Bu randevu için oda bilgisi bulunamadı', 'error');
      return;
    }
    setTokenLoading(true);
    try {
      const res = await callFunction('check-livekit-room-access', {
        roomName,
        advisorId: ADVISOR_ID,
      });
      const data = res.data as { token?: string } | null;
      const token = data?.token;
      if (token) {
        setActiveCall({ reservation: r, token });
      } else {
        setActiveCall({ reservation: r, token: null });
        toast('LiveKit token alınamadı', 'error');
      }
    } catch (e) {
      setActiveCall({ reservation: r, token: null });
      toast(String(e), 'error');
    } finally {
      setTokenLoading(false);
    }
  };

  const handleBack = () => {
    setActiveCall(null);
    setPipMode(false);
    fetchReservations();
  };

  const handleMinimize = () => setPipMode(true);
  const handleExpand = () => setPipMode(false);

  if (activeCall) {
    if (pipMode) {
      return (
        <>
          <div className="page">
            <div className="page-header">
              <h1>Görüntülü Görüşmelerim</h1>
            </div>
            <div className="empty-state" style={{ minHeight: 200 }}>
              <p className="text-muted">Görüşme küçültüldü. Sağ alttaki balona tıklayarak büyütebilirsiniz.</p>
            </div>
          </div>
          <PiPBubble onExpand={handleExpand} />
        </>
      );
    }

    if (activeCall.token) {
      return (
        <div className="page" style={{ height: '100%' }}>
          <ActiveVideoCall
            reservation={activeCall.reservation}
            token={activeCall.token}
            onBack={handleBack}
            onMinimize={handleMinimize}
          />
        </div>
      );
    }

    return (
      <div className="page">
        <VideoCallFallback reservation={activeCall.reservation} onBack={handleBack} />
      </div>
    );
  }

  const today = new Date().toISOString().slice(0, 10);
  const videoReservations = reservations.filter(
    (r) =>
      getRoomName(r) && (r.attributes?.startDateTime ?? '').slice(0, 10) === today
  );

  return (
    <div className="page">
      <div className="page-header">
        <h1>Görüntülü Görüşmelerim</h1>
      </div>
      <div className="page-grid page-grid-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Video size={20} />
              <h3>Günün Görüntülü Görüşmeleri</h3>
            </div>
          </CardHeader>
          <CardBody>
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
            ) : videoReservations.length === 0 ? (
              <EmptyState
                message="Bugün görüntülü görüşme randevusu yok"
                icon={<Video size={40} strokeWidth={1.5} />}
              />
            ) : (
              <div className="table-wrapper">
                <table>
                  <thead>
                    <tr>
                      <th>Saat</th>
                      <th>Müşteri</th>
                      <th>Durum</th>
                      <th>İşlem</th>
                    </tr>
                  </thead>
                  <tbody>
                    {videoReservations.map((r) => {
                      const state = r.metadata?.currentState ?? '';
                      const joinable = canJoin(r);
                      return (
                        <tr key={r.id ?? r.key}>
                          <td>{formatTime(r.attributes?.startDateTime)} – {formatTime(r.attributes?.endDateTime)}</td>
                          <td>{userName(r.attributes?.user)}</td>
                          <td>
                            <Badge state={state} />
                          </td>
                          <td>
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              disabled={!joinable || tokenLoading}
                              onClick={() => handleJoin(r)}
                            >
                              <Video size={14} />
                              Bağlan
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
