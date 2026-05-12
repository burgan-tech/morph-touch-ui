/** Optional Bearer used when polling rezervation / requesting LiveKit access during an active video meet. */
export function bearerAuthForVideoCall(token: string | null | undefined): Record<string, string> | undefined {
  if (!token || token.trim() === '') return undefined;
  return { Authorization: `Bearer ${token.trim()}` };
}

/** Best-effort extraction of a Morph/session token for video-related API calls from workflow instance payloads. */
export function extractTokenForVideoCall(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const attrs = (d.attributes as Record<string, unknown> | undefined) ?? {};
  const candidates: unknown[] = [
    attrs.tokenForVideoCall,
    d.tokenForVideoCall,
    attrs.videoCallAuthToken,
    attrs.morphVideoToken,
    attrs.videoMorphToken,
    d.videoCallAuthToken,
    d.morphVideoToken,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.length > 0) return c;
  }
  return null;
}

/** Morph function responses often nest the payload (`{ checkLivekitRoomAccess: { token } }`). */
export function extractMorphFunctionStringField(data: unknown, field: string): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const top = d[field];
  if (typeof top === 'string' && top.length > 0) return top;
  for (const v of Object.values(d)) {
    if (!v || typeof v !== 'object') continue;
    const inner = v as Record<string, unknown>;
    const t = inner[field];
    if (typeof t === 'string' && t.length > 0) return t;
  }
  return null;
}
