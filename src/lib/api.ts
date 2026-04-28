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

export function getInstance(workflow: string, instanceId: string) {
  return request(`${BASE_URL}/workflows/${workflow}/instances/${instanceId}`);
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

export function callFlowFunction(
  workflow: string,
  fnName: string,
  queryParams: Record<string, string> = {},
  extraHeaders?: Record<string, string>
) {
  const qs = new URLSearchParams(queryParams);
  const q = qs.toString();
  const url = `${BASE_URL}/workflows/${workflow}/functions/${fnName}${q ? `?${q}` : ''}`;
  return request(url, extraHeaders ? { headers: extraHeaders } : undefined);
}

// Convenience wrappers
/** Headers: touchUser, userType (customer|advisor|manager|admin); optional startDate, endDate. */
export function getReservations(headers: Record<string, string>) {
  return callFunction('get-rezervations', {}, headers);
}

export function getAvailableSlots(advisorId: string, date: string, duration?: string) {
  const p: Record<string, string> = { advisorId, date };
  if (duration) p.duration = duration;
  return callFunction('get-available-slots', p);
}

export function getAbsenceEntries(params: Record<string, string> = {}) {
  return callFunction('get-absence-entry', params);
}

/** Headers: touchUser, userType (customer|advisor|admin); optional roomType, state. */
export function getChatRooms(headers: Record<string, string>) {
  return callFunction('get-chat-rooms', {}, headers);
}

/** Query: limit, from, pageSize. Headers: roomId, touchUser (Matrix user id). */
export function getRoomMessages(
  queryParams: Record<string, string> = {},
  headers: Record<string, string>
) {
  return callFlowFunction('chat-room', 'get-room-messages', queryParams, headers);
}

export function sendRoomMessage(roomId: string, user: string, body: string) {
  return callFlowFunction('chat-room', 'send-room-message', { roomId, user, body, pageSize: '1' });
}

export function getMatrixSync(params: { user: string; since?: string; timeout?: string; roomId?: string }) {
  const q: Record<string, string> = { user: params.user };
  if (params.since) q.since = params.since;
  if (params.timeout) q.timeout = params.timeout;
  if (params.roomId) q.roomId = params.roomId;
  q.pageSize = '1';
  return callFlowFunction('chat-room', 'get-matrix-sync', q);
}

export function getAdvisorStats(advisorId: string, period: 'week' | 'month' = 'week') {
  return callFunction('get-advisor-stats', { advisorId, period });
}

export function getCustomerInfo(customerId: string) {
  return callFunction('get-customer-info', { customerId });
}

export function healthCheck() {
  return listInstances('absence-entry', { pageSize: 1 });
}
