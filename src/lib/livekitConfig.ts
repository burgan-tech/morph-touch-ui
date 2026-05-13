import type { RoomConnectOptions } from 'livekit-client';

export type LiveKitTurnServer = RTCIceServer;

/** WebSocket URL of the LiveKit server (falls back to local dev default used in VideoCalls). */
export function getLiveKitServerUrl(): string {
  const u = import.meta.env.VITE_LIVEKIT_URL;
  if (typeof u === 'string' && u.trim() !== '') return u.trim();
  return 'ws://localhost:7881';
}

function shouldForceRelay(): boolean {
  return import.meta.env.VITE_LIVEKIT_FORCE_RELAY === 'true';
}

function isValidTurnServer(value: unknown): value is LiveKitTurnServer {
  if (!value || typeof value !== 'object') return false;
  const server = value as Record<string, unknown>;
  const urls = server.urls;
  return typeof urls === 'string' || (Array.isArray(urls) && urls.every((url) => typeof url === 'string'));
}

export function getLiveKitConnectOptions(turnServers: unknown): RoomConnectOptions | undefined {
  if (!Array.isArray(turnServers)) return undefined;

  const iceServers = turnServers.filter(isValidTurnServer);
  if (iceServers.length === 0) return undefined;

  return {
    rtcConfig: {
      iceServers,
      ...(shouldForceRelay() ? { iceTransportPolicy: 'relay' as const } : {}),
    },
  };
}
