/**
 * Matrix presence API (Postman-compatible).
 * Uses X-Matrix-User header; no Bearer token required.
 * Proxy: /_matrix -> APISIX (localhost:9080) via vite/server.js.
 */

export type PresenceStatus = 'online' | 'busy' | 'away' | 'offline';

const BASE = import.meta.env.VITE_MATRIX_APISIX_ORIGIN ?? '';

function toMxid(advisorId: string, domain = 'localhost'): string {
  const localPart = advisorId.startsWith('@') ? advisorId.slice(1).split(':')[0] : advisorId;
  return `@${localPart}:${domain}`;
}

function toUiStatus(presence: string, statusMsg?: string): PresenceStatus {
  if (presence === 'online') return 'online';
  if (presence === 'offline') return 'offline';
  if (presence === 'unavailable') {
    if (statusMsg?.toLowerCase().includes('meşgul') || statusMsg?.toLowerCase().includes('busy')) return 'busy';
    if (statusMsg?.toLowerCase().includes('uzakta') || statusMsg?.toLowerCase().includes('away')) return 'away';
    return 'away';
  }
  return 'offline';
}

function toMatrixPayload(uiStatus: PresenceStatus): { presence: string; status_msg: string } {
  switch (uiStatus) {
    case 'online':
      return { presence: 'online', status_msg: 'Uygun' };
    case 'offline':
      return { presence: 'offline', status_msg: '' };
    case 'busy':
      return { presence: 'unavailable', status_msg: 'Meşgul' };
    case 'away':
      return { presence: 'unavailable', status_msg: 'Uzakta' };
    default:
      return { presence: 'offline', status_msg: '' };
  }
}

export interface PresenceResponse {
  presence: string;
  last_active_ago?: number;
  status_msg?: string;
}

export async function getPresence(advisorId: string): Promise<{ ok: boolean; status?: PresenceStatus; error?: string }> {
  const mxid = toMxid(advisorId);
  const url = `${BASE}/_matrix/client/v3/presence/${encodeURIComponent(mxid)}/status`;
  const xMatrixUser = advisorId.startsWith('@') ? advisorId.slice(1).split(':')[0] : advisorId;

  try {
    const res = await fetch(url, {
      method: 'GET',
      headers: { 'X-Matrix-User': xMatrixUser },
    });
    const data = (await res.json().catch(() => null)) as PresenceResponse | null;
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    const presence = data?.presence ?? 'offline';
    const statusMsg = data?.status_msg;
    const status = toUiStatus(presence, statusMsg);
    return { ok: true, status };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

export async function setPresence(advisorId: string, uiStatus: PresenceStatus): Promise<{ ok: boolean; error?: string }> {
  const mxid = toMxid(advisorId);
  const url = `${BASE}/_matrix/client/v3/presence/${encodeURIComponent(mxid)}/status`;
  const xMatrixUser = advisorId.startsWith('@') ? advisorId.slice(1).split(':')[0] : advisorId;
  const body = toMatrixPayload(uiStatus);

  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Matrix-User': xMatrixUser,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
