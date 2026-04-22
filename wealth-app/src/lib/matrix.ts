/**
 * Matrix SDK helper for chat integration.
 * Creates and manages a Matrix client for sending messages, files, and read receipts.
 * Falls back gracefully when client fails to connect.
 */

import { createClient, MatrixClient } from 'matrix-js-sdk';

const DEFAULT_HOMESERVER = 'http://localhost:9080';
const DEFAULT_USER_ID = '@advisor-1:localhost';

let client: MatrixClient | null = null;
let clientReady = false;

export interface MatrixInitOptions {
  homeserverUrl?: string;
  userId?: string;
  accessToken?: string;
}

/**
 * Initialize Matrix client with credentials.
 * Uses placeholder credentials if not provided (userId from env or default, accessToken from env or empty).
 */
export async function initMatrix(options: MatrixInitOptions = {}): Promise<boolean> {
  const baseUrl = options.homeserverUrl ?? import.meta.env.VITE_MATRIX_HOMESERVER ?? DEFAULT_HOMESERVER;
  const userId = options.userId ?? import.meta.env.VITE_MATRIX_USER_ID ?? DEFAULT_USER_ID;
  const accessToken = options.accessToken ?? import.meta.env.VITE_MATRIX_ACCESS_TOKEN ?? '';

  if (!accessToken) {
    console.warn('[matrix] No access token provided; Matrix client will not be authenticated');
    return false;
  }

  try {
    client = createClient({
      baseUrl,
      userId,
      accessToken,
    });
    await client.startClient({ initialSyncLimit: 0 });
    clientReady = true;
    return true;
  } catch (err) {
    console.error('[matrix] Failed to init client:', err);
    client = null;
    clientReady = false;
    return false;
  }
}

export function isMatrixReady(): boolean {
  return clientReady && client !== null;
}

export function getMatrixClient(): MatrixClient | null {
  return client;
}

/**
 * Send a text message to a Matrix room.
 */
export async function sendMessage(roomId: string, body: string): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!client || !clientReady) {
    return { ok: false, error: 'Matrix client not ready' };
  }
  try {
    const res = await client.sendTextMessage(roomId, body);
    return { ok: true, eventId: res.event_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Upload a file and send it as a message to a Matrix room.
 */
export async function sendFileMessage(roomId: string, file: File): Promise<{ ok: boolean; eventId?: string; error?: string }> {
  if (!client || !clientReady) {
    return { ok: false, error: 'Matrix client not ready' };
  }
  try {
    const uploadRes = await client.uploadContent(file);
    const mxcUrl = uploadRes.content_uri;
    const filename = file.name;
    const mimetype = file.type || 'application/octet-stream';

    const content = {
      msgtype: 'm.file' as const,
      body: filename,
      url: mxcUrl,
      info: {
        mimetype,
        size: file.size,
      },
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const res = await client.sendMessage(roomId, content as any);
    return { ok: true, eventId: res.event_id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}

/**
 * Mark a room/message as read by sending a read receipt.
 * eventId: the event ID of the last read message. Required for Matrix read receipts.
 */
export async function markAsRead(roomId: string, eventId: string): Promise<{ ok: boolean; error?: string }> {
  if (!client || !clientReady) {
    return { ok: false, error: 'Matrix client not ready' };
  }
  try {
    await client.setRoomReadMarkersHttpRequest(roomId, eventId, eventId);
    return { ok: true };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, error: msg };
  }
}
