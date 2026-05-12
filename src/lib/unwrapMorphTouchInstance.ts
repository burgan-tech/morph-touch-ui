/**
 * Morph-touch workflow instance payloads are sometimes wrapped (`instance`, `data`, `items[0]`).
 * Returns the inner object that carries `attributes` / video fields so callers can read them uniformly.
 */
export function unwrapMorphTouchInstance(payload: unknown): unknown {
  if (payload == null || typeof payload !== 'object') return payload;
  const o = payload as Record<string, unknown>;
  const attrs = o.attributes;
  if (attrs != null && typeof attrs === 'object') return payload;
  if (o.videoCallUrls != null || o.webrtcIntegration != null) return payload;
  if (o.instance != null) return unwrapMorphTouchInstance(o.instance);
  if (o.data != null) return unwrapMorphTouchInstance(o.data);
  if (Array.isArray(o.items) && o.items.length > 0) return unwrapMorphTouchInstance(o.items[0]);
  return payload;
}
