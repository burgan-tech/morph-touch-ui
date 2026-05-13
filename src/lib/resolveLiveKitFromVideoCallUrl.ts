export interface ResolvedLiveKitJoin {
  serverUrl: string;
  /** LiveKit `token` prop: JWT from URL **or** `generate:roomName:participantName` for Morph gateway + patch. */
  token: string;
}

/** `https?` / `wss?` → WebSocket base URL including pathname (e.g. `/ebanking/livekit/rtc`). */
function websocketServerUrl(url: URL): string | null {
  const p = url.protocol.toLowerCase();
  const origin =
    p === 'https:'
      ? `wss://${url.host}`
      : p === 'http:'
        ? `ws://${url.host}`
        : p === 'wss:'
          ? `wss://${url.host}`
          : p === 'ws:'
            ? `ws://${url.host}`
            : null;
  if (!origin) return null;
  const path = url.pathname && url.pathname !== '/' ? url.pathname : '';
  return `${origin}${path}`;
}

/**
 * Morph / Burgan: `videoCallUrls` entry is often
 * `https://host/.../livekit/rtc?room=...&user=...&autoJoin=1` — no JWT in the URL.
 * Patched client sends `access_token` = morph `tokenForVideoCall` and `room_token` = `generate:room:user`.
 *
 * Legacy: JWT in `access_token` / `token` / … query params.
 */
export function resolveLiveKitFromVideoCallUrl(raw: string): ResolvedLiveKitJoin | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const url = new URL(trimmed);
    const room = url.searchParams.get('room');
    const participant = url.searchParams.get('user');
    if (room && participant) {
      const serverUrl = websocketServerUrl(url);
      if (!serverUrl) return null;
      return { serverUrl, token: `generate:${room}:${participant}` };
    }

    const jwt =
      url.searchParams.get('access_token') ??
      url.searchParams.get('token') ??
      url.searchParams.get('room_token') ??
      url.searchParams.get('livekit_token');
    if (!jwt) return null;

    const serverUrl = websocketServerUrl(url);
    if (!serverUrl) return null;
    return { serverUrl, token: jwt };
  } catch {
    return null;
  }
}
