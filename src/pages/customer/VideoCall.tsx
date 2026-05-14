import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Video, PhoneOff, Scan } from 'lucide-react';
import { Track, type RoomConnectOptions } from 'livekit-client';
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
import { callFunction, getInstance } from '../../lib/api';
import { getLiveKitConnectOptions, getLiveKitServerUrl } from '../../lib/livekitConfig';
import { resolveLiveKitFromVideoCallUrl } from '../../lib/resolveLiveKitFromVideoCallUrl';
import {
  bearerAuthForVideoCall,
  extractMorphFunctionStringField,
  extractTokenForVideoCall,
} from '../../lib/rezervationVideoToken';
import { unwrapMorphTouchInstance } from '../../lib/unwrapMorphTouchInstance';
import { setLiveKitMorphVideoToken } from '../../lib/livekitMorphToken';
import { cn } from '../../lib/utils';
import { toast } from '../../components/ui';
import { VideoCallMatrixChat } from '../../components/VideoCallMatrixChat';
import { useCustomerContext } from '../../contexts/CustomerContext';
import { extractChatIntegrationMatrixRoomId } from '../../lib/rezervationChatIntegration';

interface RezervationAttributes {
  videoCallUrls?: Record<string, string>[];
  turnServers?: unknown[];
  webrtcIntegration?: { livekit?: { room?: string } };
}

function extractAttributes(data: unknown): RezervationAttributes {
  if (!data || typeof data !== 'object') return {};
  const d = data as Record<string, unknown>;
  const attrs = (d.attributes as Record<string, unknown> | undefined) ?? {};
  return {
    videoCallUrls: (attrs.videoCallUrls ?? d.videoCallUrls) as Record<string, string>[] | undefined,
    turnServers: (attrs.turnServers ?? d.turnServers) as unknown[] | undefined,
    webrtcIntegration: (attrs.webrtcIntegration ?? d.webrtcIntegration) as RezervationAttributes['webrtcIntegration'],
  };
}

function CustomerVideoControls({ onLeave }: { onLeave: () => void }) {
  const [blurEnabled, setBlurEnabled] = useState(false);
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
        await videoTrack.setProcessor(BackgroundBlur(10));
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
        className={blurEnabled ? 'active' : 'inactive'}
        onClick={toggleBlur}
        title="Arka plan bulanıklaştırma"
      >
        <Scan size={18} />
      </button>
      <button type="button" className="end-call" onClick={onLeave} title="Görüşmeyi bitir">
        <PhoneOff size={20} />
      </button>
    </div>
  );
}

function RemoteAdvisorStage() {
  const tracks = useTracks([Track.Source.Camera, Track.Source.ScreenShare]);
  const remote = tracks.filter((ref) => ref.participant && !ref.participant.isLocal);
  const screenShare = remote.find((t) => t.source === Track.Source.ScreenShare);
  const mainTrack = screenShare ?? remote[0];

  return (
    <div
      className="video-call-main"
      style={{
        flex: 1,
        display: 'flex',
        flexDirection: 'column',
        position: 'relative',
        background: '#0f172a',
        minHeight: 0,
      }}
    >
      <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        {mainTrack ? (
          <VideoTrack trackRef={mainTrack} style={{ width: '100%', height: '100%', objectFit: 'contain' }} />
        ) : (
          <div className="empty-state" style={{ color: '#94a3b8' }}>
            <Video size={48} strokeWidth={1.5} />
            <p>Danışman video akışı bekleniyor</p>
          </div>
        )}
      </div>
    </div>
  );
}

function LocalCameraPreview() {
  const tracks = useTracks([Track.Source.Camera]);
  const local = tracks.find((ref) => ref.participant?.isLocal && ref.source === Track.Source.Camera);
  if (!local) return null;
  return (
    <div
      style={{
        position: 'absolute',
        right: 16,
        bottom: 88,
        width: 140,
        height: 105,
        borderRadius: 8,
        overflow: 'hidden',
        border: '2px solid rgba(255,255,255,0.25)',
        boxShadow: '0 4px 12px rgba(0,0,0,0.4)',
        zIndex: 2,
        background: '#000',
      }}
    >
      <VideoTrack trackRef={local} style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
    </div>
  );
}

function ActiveCustomerCall({
  serverUrl,
  token,
  morphVideoToken,
  connectOptions,
  matrixRoomId,
  customerId,
  customerName,
  onLeave,
  onCallFailure,
}: {
  serverUrl: string;
  token: string;
  morphVideoToken: string | null;
  connectOptions?: RoomConnectOptions;
  matrixRoomId: string | null;
  customerId: string;
  customerName?: string;
  onLeave: () => void;
  onCallFailure: (message: string) => void;
}) {
  const userInitiatedLeave = useRef(false);
  const failureReported = useRef(false);

  const reportFailureOnce = useCallback(
    (message: string) => {
      if (failureReported.current) return;
      failureReported.current = true;
      onCallFailure(message);
    },
    [onCallFailure],
  );

  const handleUserLeave = useCallback(() => {
    userInitiatedLeave.current = true;
    onLeave();
  }, [onLeave]);

  const handleRoomDisconnected = useCallback(() => {
    if (userInitiatedLeave.current) return;
    reportFailureOnce('Görüşme bağlantısı kesildi.');
  }, [reportFailureOnce]);

  useLayoutEffect(() => {
    setLiveKitMorphVideoToken(morphVideoToken);
    return () => setLiveKitMorphVideoToken(null);
  }, [morphVideoToken]);

  return (
    <LiveKitRoom
      serverUrl={serverUrl}
      token={token}
      connect
      video
      audio
      connectOptions={connectOptions}
      onDisconnected={handleRoomDisconnected}
      onError={(err) => {
        console.error('[LiveKit]', err);
        toast(err.message, 'error');
        reportFailureOnce(err.message || String(err));
      }}
      style={{ display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 }}
    >
      <RoomAudioRenderer />
      <div style={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
        <div className="video-call-container" style={{ flex: 1, minHeight: 0, position: 'relative' }}>
          <div className="video-call-main" style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
            <div style={{ flex: 1, position: 'relative', display: 'flex', flexDirection: 'column', minHeight: 0 }}>
              <RemoteAdvisorStage />
              <LocalCameraPreview />
              <CustomerVideoControls onLeave={handleUserLeave} />
            </div>
          </div>
        </div>
        <VideoCallMatrixChat
          matrixRoomId={matrixRoomId}
          role="customer"
          customerId={customerId}
          customerDisplayName={customerName}
        />
      </div>
    </LiveKitRoom>
  );
}

export function VideoCall() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { customerId, customerName } = useCustomerContext();
  const rezervationId = searchParams.get('rezervation')?.trim() ?? '';

  const [phase, setPhase] = useState<'poll' | 'live' | 'error'>('poll');
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [serverUrl, setServerUrl] = useState<string | null>(null);
  const [morphVideoToken, setMorphVideoToken] = useState<string | null>(null);
  const [connectOptions, setConnectOptions] = useState<RoomConnectOptions | undefined>();
  const [matrixRoomId, setMatrixRoomId] = useState<string | null>(null);

  const goDashboard = useCallback(() => {
    navigate('/customer', { replace: true });
  }, [navigate]);

  const handleCallFailure = useCallback((message: string) => {
    console.error('[VideoCall]', message);
    setErrorMsg(message);
    setPhase('error');
    setToken(null);
    setServerUrl(null);
    setMorphVideoToken(null);
    setConnectOptions(undefined);
    setMatrixRoomId(null);
  }, []);

  useEffect(() => {
    if (!rezervationId) {
      setErrorMsg('Randevu bilgisi eksik.');
      setPhase('error');
      return;
    }
    if (!customerId) {
      setErrorMsg('Oturum bulunamadı; lütfen tekrar giriş yapın.');
      setPhase('error');
      return;
    }

    setMatrixRoomId(null);
    const cancelledRef = { current: false };
    const timerRef = { current: undefined as ReturnType<typeof setTimeout> | undefined };
    const videoAuthRef = { current: null as string | null };
    const pollAttemptsRef = { current: 0 };

    const schedule = (fn: () => void, ms: number) => {
      if (timerRef.current) clearTimeout(timerRef.current);
      timerRef.current = setTimeout(fn, ms);
    };

    const tryFetchTokenViaRoom = async (roomName: string): Promise<string | null> => {
      try {
        const res = await callFunction(
          'check-livekit-room-access',
          {
            roomName,
            customerId,
          },
          bearerAuthForVideoCall(videoAuthRef.current),
        );
        if (!res.ok) return null;
        return extractMorphFunctionStringField(res.data, 'token');
      } catch {
        return null;
      }
    };

    const poll = async () => {
      if (cancelledRef.current) return;
      pollAttemptsRef.current += 1;
      if (pollAttemptsRef.current > 50) {
        setErrorMsg(
          'Görüşme bağlantısı zaman aşımına uğradı. Randevu kaydında video bağlantısı yoksa danışmanın görüşmeyi başlatması gerekir.',
        );
        setPhase('error');
        return;
      }
      try {
        const res = await getInstance(
          'rezervation',
          rezervationId,
          bearerAuthForVideoCall(videoAuthRef.current),
        );
        if (cancelledRef.current) return;
        if (!res.ok) {
          schedule(() => void poll(), 3000);
          return;
        }
        const instanceRoot = unwrapMorphTouchInstance(res.data);
        const morphTok = extractTokenForVideoCall(instanceRoot);
        if (morphTok) videoAuthRef.current = morphTok;
        const { videoCallUrls, turnServers, webrtcIntegration } = extractAttributes(instanceRoot);
        const liveKitConnectOptions = getLiveKitConnectOptions(turnServers);
        if (videoCallUrls && Array.isArray(videoCallUrls) && videoCallUrls.length > 0) {
          const myEntry =
            videoCallUrls.find((u) => u && customerId in u) ??
            videoCallUrls.find((u) => u && Object.keys(u).length > 0);
          const rawCandidates: string[] = [];
          if (myEntry) {
            const mine = myEntry[customerId];
            if (typeof mine === 'string' && mine.length > 0) rawCandidates.push(mine);
            for (const v of Object.values(myEntry)) {
              if (typeof v === 'string' && v.length > 0 && !rawCandidates.includes(v)) rawCandidates.push(v);
            }
          }
          for (const raw of rawCandidates) {
            const resolved = resolveLiveKitFromVideoCallUrl(raw);
            if (resolved) {
              const usesMorphGateway = resolved.token.startsWith('generate:');
              if (usesMorphGateway && !morphTok) {
                break;
              }
              setMorphVideoToken(usesMorphGateway ? morphTok : null);
              setConnectOptions(liveKitConnectOptions);
              setServerUrl(resolved.serverUrl);
              setToken(resolved.token);
              setMatrixRoomId(extractChatIntegrationMatrixRoomId(instanceRoot));
              setPhase('live');
              return;
            }
          }
        }
        const roomName = webrtcIntegration?.livekit?.room;
        if (roomName && typeof roomName === 'string' && roomName.length > 0) {
          const t = await tryFetchTokenViaRoom(roomName);
          if (!cancelledRef.current && t) {
            setMorphVideoToken(null);
            setConnectOptions(liveKitConnectOptions);
            setServerUrl(getLiveKitServerUrl());
            setToken(t);
            setMatrixRoomId(extractChatIntegrationMatrixRoomId(instanceRoot));
            setPhase('live');
            return;
          }
        }
      } catch {
        /* retry */
      }
      if (!cancelledRef.current) schedule(() => void poll(), 3000);
    };

    schedule(() => void poll(), 1500);

    return () => {
      cancelledRef.current = true;
      if (timerRef.current) clearTimeout(timerRef.current);
    };
  }, [rezervationId, customerId]);

  if (!rezervationId || phase === 'error') {
    return (
      <div className="page" style={{ maxWidth: 480, margin: '0 auto', padding: 24 }}>
        <div className="empty-state">
          <Video size={40} strokeWidth={1.5} />
          <p style={{ fontWeight: 600 }}>Görüntülü görüşme açılamadı</p>
          <p className="text-muted text-sm">{errorMsg ?? 'Geçersiz bağlantı.'}</p>
          <button type="button" className="btn btn-primary mt-3" onClick={goDashboard}>
            Panele dön
          </button>
        </div>
      </div>
    );
  }

  if (phase === 'poll' || !token || !serverUrl || !customerId) {
    return (
      <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', padding: 24 }}>
        <Video size={48} strokeWidth={1.5} style={{ marginBottom: 16, color: 'var(--color-primary)' }} />
        <p style={{ fontWeight: 600, marginBottom: 8 }}>Görüşme hazırlanıyor</p>
        <p className="text-muted text-sm text-center">Bağlantı bilgileri alınıyor; lütfen bekleyin.</p>
        <div
          className="animate-spin mt-6"
          style={{
            width: 28,
            height: 28,
            border: '3px solid var(--color-border)',
            borderTopColor: 'var(--color-primary)',
            borderRadius: '50%',
          }}
        />
        <button type="button" className="btn btn-secondary mt-8" onClick={goDashboard}>
          İptal
        </button>
      </div>
    );
  }

  return (
    <div className="page" style={{ height: '100%', display: 'flex', flexDirection: 'column' }}>
      <ActiveCustomerCall
        serverUrl={serverUrl}
        token={token}
        morphVideoToken={morphVideoToken}
        connectOptions={connectOptions}
        matrixRoomId={matrixRoomId}
        customerId={customerId}
        customerName={customerName ?? undefined}
        onLeave={goDashboard}
        onCallFailure={handleCallFailure}
      />
    </div>
  );
}
