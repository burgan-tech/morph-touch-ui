/**
 * Matrix room id from rezervation instance attributes (video call + chat).
 * Supports `chatIntegration.roomId` and `chatIntegration.matrix.roomId`.
 */
export function extractChatIntegrationMatrixRoomId(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const attrs = (d.attributes as Record<string, unknown> | undefined) ?? {};
  const ci = (attrs.chatIntegration ?? d.chatIntegration) as Record<string, unknown> | undefined;
  if (!ci || typeof ci !== 'object') return null;
  const top = ci.roomId;
  if (typeof top === 'string' && top.length > 0) return top;
  const matrix = ci.matrix as { roomId?: string } | undefined;
  const nested = matrix?.roomId;
  if (typeof nested === 'string' && nested.length > 0) return nested;
  return null;
}

/** Randevu müşteri anahtarı (TCKN veya ref.key) — danışman sohbetinde isim çözümü için. */
export function extractRezervationUserTouchKey(data: unknown): string | null {
  if (!data || typeof data !== 'object') return null;
  const d = data as Record<string, unknown>;
  const attrs = (d.attributes as Record<string, unknown> | undefined) ?? {};
  const user = attrs.user ?? d.user;
  if (typeof user === 'string' && user.trim()) return user.trim();
  if (user && typeof user === 'object' && user != null && 'key' in user) {
    const k = String((user as { key: unknown }).key ?? '').trim();
    return k || null;
  }
  return null;
}
