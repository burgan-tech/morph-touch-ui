const BASE_URL = '/api/v1/morph-touch';

interface ApiResponse<T = unknown> {
  ok: boolean;
  status: number;
  data: T;
  elapsed: number;
}

async function request<T = unknown>(
  url: string,
  options: RequestInit = {}
): Promise<ApiResponse<T>> {
  const start = performance.now();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'application/json',
    'Accept-Language': 'tr-TR',
    'X-Request-Id': crypto.randomUUID(),
    ...((options.headers as Record<string, string>) || {}),
  };

  try {
    const res = await fetch(url, { ...options, headers });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data: data as T, elapsed: performance.now() - start };
  } catch {
    return { ok: false, status: 0, data: null as T, elapsed: performance.now() - start };
  }
}

/**
 * Validates that all listed parameters are non-empty strings. Throws a descriptive
 * Error listing the missing keys so the failure is visible at the call site (UI
 * try/catch) instead of relying on the backend's VALIDATION_ERROR response.
 */
function requireParams(
  fnName: string,
  values: Record<string, string | undefined>
): void {
  const missing = Object.entries(values)
    .filter(([, v]) => !v || v.trim() === '')
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(
      `${fnName}: required parameter(s) missing: ${missing.join(', ')}`
    );
  }
}

// Workflow instance operations
export function startInstance(
  workflow: string,
  body: Record<string, unknown>,
  headers?: Record<string, string>
) {
  return request(`${BASE_URL}/workflows/${workflow}/instances/start?sync=true`, {
    method: 'POST',
    body: JSON.stringify(body),
    headers,
  });
}

export function getInstance(
  workflow: string,
  instanceId: string,
  headers?: Record<string, string>
) {
  return request(`${BASE_URL}/workflows/${workflow}/instances/${instanceId}`, headers ? { headers } : undefined);
}

export function listInstances(
  workflow: string,
  params: Record<string, string | number> = {}
) {
  const qs = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    qs.set(k, typeof v === 'object' ? JSON.stringify(v) : String(v));
  });
  return request(`${BASE_URL}/workflows/${workflow}/instances?${qs}`);
}

export function runTransition(
  workflow: string,
  instanceId: string,
  transitionKey: string,
  body: Record<string, unknown> = {},
  sync = true
) {
  const qs = sync ? '?sync=true' : '';
  return request(`${BASE_URL}/workflows/${workflow}/instances/${instanceId}/transitions/${transitionKey}${qs}`, {
    method: 'PATCH',
    body: JSON.stringify(body),
  });
}

// Domain function calls
export function callFunction(
  fnName: string,
  queryParams: Record<string, string> = {},
  extraHeaders?: Record<string, string>
) {
  const qs = new URLSearchParams(queryParams);
  const q = qs.toString();
  return request(
    `${BASE_URL}/functions/${fnName}${q ? `?${q}` : ''}`,
    extraHeaders ? { headers: extraHeaders } : undefined
  );
}

// Convenience wrappers
/** Headers: touchUser, userType (customer|advisor|manager|admin); optional startDate, endDate. */
export function getReservations(headers: Record<string, string>) {
  requireParams('getReservations', {
    touchUser: headers.touchUser,
    userType: headers.userType,
  });
  return callFunction('get-rezervations', {}, headers);
}

/** Headers: advisorId, requestedDate; optional duration, timeZone. */
export function getAvailableSlots(advisorId: string, requestedDate: string, duration?: string) {
  requireParams('getAvailableSlots', { advisorId, requestedDate });
  const headers: Record<string, string> = { advisorId, requestedDate };
  if (duration) headers.duration = duration;
  return callFunction('get-available-slots', {}, headers);
}

/** Headers: absenceType (required); optional advisor, pageSize, startDate, endDate. */
export function getAbsenceEntries(params: Record<string, string> = {}) {
  requireParams('getAbsenceEntries', { absenceType: params.absenceType });
  return callFunction('get-absence-entry', {}, params);
}

/**
 * Fetch chat rooms via the `get-chat-rooms` flow-level function.
 *
 * Required headers: `touchUser`, `userType` (customer|advisor|admin).
 * Optional headers: `roomType`, `state`.
 *
 * The function returns `{ getChatRooms: { rooms: [...] } }` which the chat UI
 * components extract directly.
 */
export function getChatRooms(headers: {
  touchUser: string;
  userType: string;
  roomType?: string;
  state?: string;
}) {
  requireParams('getChatRooms', {
    touchUser: headers.touchUser,
    userType: headers.userType,
  });
  const fnHeaders: Record<string, string> = {
    touchUser: headers.touchUser,
    userType: headers.userType,
  };
  if (headers.roomType) fnHeaders.roomType = headers.roomType;
  if (headers.state) fnHeaders.state = headers.state;
  return callFunction('get-chat-rooms', {}, fnHeaders);
}

/**
 * Fetch Matrix messages for a chat room via the `get-room-messages` function.
 *
 * Required headers: `roomId`, `user` (Matrix user id). Existing call sites pass
 * `touchUser` (legacy alias from other functions); we map it to `user` here so
 * those don't need to change individually. Optional: `limit`, `from`, `userType`
 * (`advisor` = Matrix login without customer `u` prefix).
 */
export function getRoomMessages(
  queryParams: Record<string, string> = {},
  headers: Record<string, string>
) {
  const { touchUser, user, ...rest } = headers;
  const normalized: Record<string, string> = { ...rest };
  const matrixUser = user ?? touchUser;
  if (matrixUser) normalized.user = matrixUser;
  requireParams('getRoomMessages', {
    roomId: normalized.roomId,
    user: matrixUser,
  });
  normalized.sub = matrixUser;
  normalized.act_sub = matrixUser;
  return callFunction('get-room-messages', queryParams, normalized);
}

/**
 * Send a chat message via the `send-room-message` function.
 * HTTP headers must be ASCII-only; non-ASCII characters (Türkçe ş/ç/ğ/…)
 * make `fetch` throw a TypeError silently. We URL-encode the body here and
 * the backend mapping calls `Uri.UnescapeDataString` to recover it.
 */
export function sendRoomMessage(
  roomId: string,
  user: string,
  body: string,
  opts?: { userType?: string }
) {
  requireParams('sendRoomMessage', { roomId, user, body });
  const headers: Record<string, string> = {
    roomId,
    user,
    sub: user,
    act_sub: user,
    body: encodeURIComponent(body),
    bodyEncoding: 'url',
  };
  if (opts?.userType) headers.userType = opts.userType;
  return callFunction('send-room-message', { pageSize: '1' }, headers);
}

/** Headers: user (required); optional since, timeout, roomId, userType (advisor skips Matrix login "u" prefix). Query: pageSize. */
export function getMatrixSync(params: {
  user: string;
  since?: string;
  timeout?: string;
  roomId?: string;
  userType?: string;
}) {
  requireParams('getMatrixSync', { user: params.user });
  const headers: Record<string, string> = {
    user: params.user,
    sub: params.user,
    act_sub: params.user,
  };
  if (params.since) headers.since = params.since;
  if (params.timeout) headers.timeout = params.timeout;
  if (params.roomId) headers.roomId = params.roomId;
  if (params.userType) headers.userType = params.userType;
  return callFunction('get-matrix-sync', { pageSize: '1' }, headers);
}

/** Headers: advisorId, period; optional startDate, endDate. */
export function getAdvisorStats(advisorId: string, period: 'week' | 'month' = 'week') {
  requireParams('getAdvisorStats', { advisorId });
  return callFunction('get-advisor-stats', {}, { advisorId, period });
}

/** Headers: customerId. */
export function getCustomerInfo(customerId: string) {
  requireParams('getCustomerInfo', { customerId });
  return callFunction('get-customer-info', {}, { customerId });
}

/**
 * Returns whether an advisor currently has an active personal-leave window.
 * Backed by the `get-advisor-on-leave` morph-touch function which queries
 * `absence-entry` instances in `active-leave` state for that advisor.
 *
 * Response data shape:
 *   { advisorId, onLeave, advisorOnLeave, currentLeave?: { absenceEntryKey, startDateTime, endDateTime } }
 */
export function getAdvisorOnLeave(advisorId: string) {
  requireParams('getAdvisorOnLeave', { advisorId });
  return callFunction('get-advisor-on-leave', {}, { advisorId });
}

/**
 * Forces a Matrix presence write for an advisor (admin / reconcile).
 * targetPresence: 'unavailable' | 'online'. statusMsg short text (e.g. 'İzinli').
 * reason: free-form audit tag (e.g. 'reconcile', 'leave-cancel').
 */
export function syncAdvisorPresence(
  advisorId: string,
  targetPresence: 'unavailable' | 'online',
  statusMsg: string = '',
  reason: string = 'reconcile'
) {
  requireParams('syncAdvisorPresence', { advisorId, targetPresence });
  return callFunction(
    'sync-advisor-presence',
    {},
    { advisorId, targetPresence, statusMsg, reason }
  );
}

export interface AdvisorLeaveDetail {
  absenceEntryKey?: string;
  startDateTime?: string;
  endDateTime?: string;
}

/**
 * Composite advisor presence read used by the customer Dashboard, advisor
 * Topbar and admin screens.
 *
 * 1. Calls `get-advisor-on-leave` (vNext) to check whether the advisor has an
 *    active personal-leave window. This is the authoritative "İzinli" signal.
 * 2. In parallel calls Matrix `getPresence` for the same advisor so the UI
 *    can still display normal away/busy/online states for non-leave cases.
 *
 * When `onLeave` is true the function forces `presence: 'away'` and
 * `statusMsg: 'İzinli'` regardless of what Matrix returned, so a stale Matrix
 * presence cannot mask an active leave window.
 */
export async function getAdvisorPresence(advisorId: string): Promise<{
  ok: boolean;
  presence: 'online' | 'busy' | 'away' | 'offline';
  statusMsg: string;
  onLeave: boolean;
  currentLeave?: AdvisorLeaveDetail;
  error?: string;
}> {
  const { getPresence } = await import('./matrixPresence');

  const [leaveResp, presenceResp] = await Promise.all([
    getAdvisorOnLeave(advisorId).catch((err) => ({ ok: false, status: 0, data: null as unknown, elapsed: 0, error: err })),
    getPresence(advisorId),
  ]);

  type LeaveData = {
    getAdvisorOnLeave?: { onLeave?: boolean; advisorOnLeave?: boolean; currentLeave?: AdvisorLeaveDetail };
    onLeave?: boolean;
    advisorOnLeave?: boolean;
    currentLeave?: AdvisorLeaveDetail;
  };
  const raw = (leaveResp && 'data' in leaveResp ? leaveResp.data : null) as LeaveData | null;
  const node = raw?.getAdvisorOnLeave ?? raw ?? null;
  const onLeave = Boolean(node?.onLeave ?? node?.advisorOnLeave ?? false);
  const currentLeave = node?.currentLeave;

  if (onLeave) {
    return {
      ok: true,
      presence: 'away',
      statusMsg: 'İzinli',
      onLeave: true,
      currentLeave,
    };
  }

  if (!presenceResp.ok) {
    return {
      ok: false,
      presence: 'offline',
      statusMsg: '',
      onLeave: false,
      error: presenceResp.error,
    };
  }

  return {
    ok: true,
    presence: (presenceResp.status ?? 'offline') as 'online' | 'busy' | 'away' | 'offline',
    statusMsg: '',
    onLeave: false,
  };
}

export function healthCheck() {
  return listInstances('absence-entry', { pageSize: 1 });
}
