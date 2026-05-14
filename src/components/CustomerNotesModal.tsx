import { useCallback, useEffect, useState } from 'react';
import { FileText, RefreshCw, Trash2, User } from 'lucide-react';
import {
  addCustomerNote,
  deleteCustomerNote,
  getCustomerNotes,
  type CustomerNote,
} from '../lib/api';
import { Modal, toast } from './ui';

interface CustomerNotesModalProps {
  open: boolean;
  onClose: () => void;
  /**
   * `loginName` value sent in the POST body (mapped to `login_name` header
   * by the API helper). Today this carries the same string as `customerTckn`
   * because chat/appointments rows only expose `attributes.user`.
   */
  customerLoginName: string;
  /** Used as upstream `{tckn}` path segment on GET/POST/DELETE. */
  customerTckn: string;
  /**
   * Sicil of the advisor viewing the notes. Sent as `loginName` query string
   * to the upstream `GET customer-notes` endpoint (required by the gateway
   * for audit). Pass `useAdvisorContext().advisorId` from the calling page.
   */
  advisorLoginName: string;
  /** Optional human-readable label shown in the header (defaults to tckn/loginName). */
  customerDisplayName?: string;
}

interface NotesEnvelope {
  notes?: unknown;
  data?: { notes?: unknown };
  getCustomerNotes?: { notes?: unknown };
  items?: Array<{ getCustomerNotes?: { notes?: unknown } }>;
}

/**
 * vNext function responses are not always wrapped consistently -- the same
 * pattern as `extractRooms` in chat pages. Try the common shapes in order
 * and fall back to an empty list.
 */
function extractNotes(payload: unknown): CustomerNote[] {
  if (!payload || typeof payload !== 'object') return [];
  const env = payload as NotesEnvelope;

  const direct =
    (env.notes as unknown) ??
    env.data?.notes ??
    env.getCustomerNotes?.notes;
  if (Array.isArray(direct)) return direct as CustomerNote[];

  const fromItems = Array.isArray(env.items)
    ? env.items.flatMap((it) => it?.getCustomerNotes?.notes ?? [])
    : [];
  if (fromItems.length > 0) return fromItems as CustomerNote[];

  return [];
}

/**
 * Upstream `loginName` filter (query string) is broken on the gateway today —
 * it ignores the parameter and returns the full note set across all advisors.
 * Until the gateway is fixed, we filter client-side by `recordBy` (mapped to
 * `loginName` in our backend normalizer) so each advisor only sees their own
 * notes. Comparison is case-insensitive and tolerates surrounding whitespace.
 */
function sicilEquals(a: string | undefined, b: string | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLocaleLowerCase('tr') === b.trim().toLocaleLowerCase('tr');
}

function filterNotesByAdvisor(
  notes: CustomerNote[],
  advisorLoginName: string,
): CustomerNote[] {
  if (!advisorLoginName) return [];
  return notes.filter((n) => sicilEquals(n.loginName, advisorLoginName));
}

export function CustomerNotesModal({
  open,
  onClose,
  customerLoginName,
  customerTckn,
  advisorLoginName,
  customerDisplayName,
}: CustomerNotesModalProps) {
  const [notes, setNotes] = useState<CustomerNote[]>([]);
  const [loading, setLoading] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [deletingId, setDeletingId] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const fetchNotes = useCallback(async () => {
    if (!customerTckn) {
      setNotes([]);
      return;
    }
    if (!advisorLoginName) {
      toast('Danışman bilgisi alınamadı; notlar yüklenemez', 'error');
      setNotes([]);
      return;
    }
    setLoading(true);
    try {
      const res = await getCustomerNotes(customerTckn, advisorLoginName);
      if (res.ok) {
        const all = extractNotes(res.data);
        setNotes(filterNotesByAdvisor(all, advisorLoginName));
      } else {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Notlar yüklenemedi (${res.status})`), 'error');
        setNotes([]);
      }
    } catch (e) {
      toast(String(e), 'error');
      setNotes([]);
    } finally {
      setLoading(false);
    }
  }, [customerTckn, advisorLoginName]);

  useEffect(() => {
    if (open) {
      setDraft('');
      fetchNotes();
    } else {
      setNotes([]);
      setDeletingId(null);
    }
  }, [open, fetchNotes]);

  const handleAdd = async () => {
    const text = draft.trim();
    if (!text) {
      toast('Lütfen bir not yazın', 'error');
      return;
    }
    if (!customerTckn) {
      toast('Müşteri bilgisi eksik; not eklenemez', 'error');
      return;
    }
    if (!advisorLoginName) {
      toast('Danışman bilgisi alınamadı; not eklenemez', 'error');
      return;
    }
    setSubmitting(true);
    try {
      // Upstream beklediği için body.loginName = advisor sicili olmalı (müşteri TCKN'si değil).
      const res = await addCustomerNote(customerTckn, advisorLoginName, text);
      if (res.ok && (res.data as Record<string, unknown>)?.success !== false) {
        setDraft('');
        toast('Not eklendi', 'success');
        await fetchNotes();
      } else {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Not eklenemedi (${res.status})`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setSubmitting(false);
    }
  };

  const handleDelete = async (note: CustomerNote) => {
    if (!note.id) {
      toast('Bu notun kimliği yok; silinemez', 'error');
      return;
    }
    if (!customerTckn) {
      toast('Müşteri bilgisi eksik; not silinemez', 'error');
      return;
    }
    setDeletingId(note.id);
    try {
      const res = await deleteCustomerNote(customerTckn, note.id);
      if (res.ok && (res.data as Record<string, unknown>)?.success !== false) {
        toast('Not silindi', 'success');
        await fetchNotes();
      } else {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Not silinemedi (${res.status})`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setDeletingId(null);
    }
  };

  const headerName =
    customerDisplayName?.trim() || customerLoginName || customerTckn || '—';

  return (
    <Modal open={open} onClose={onClose} title="Müşteri Notları">
      <div className="flex flex-col gap-4">
        <div className="flex items-center gap-2">
          <User size={18} />
          <span className="font-medium">{headerName}</span>
        </div>

        <section>
          <h4 className="text-sm font-semibold mb-2 flex items-center gap-2">
            <FileText size={16} />
            Notlar
          </h4>
          {loading ? (
            <div
              className="empty-state"
              style={{ padding: '24px 0' }}
            >
              <RefreshCw size={20} className="animate-spin" />
              <p className="text-muted text-sm m-0">Yükleniyor...</p>
            </div>
          ) : notes.length === 0 ? (
            <p className="text-muted text-sm m-0">Bu müşteri için henüz not yok.</p>
          ) : (
            <ul
              className="flex flex-col gap-2"
              style={{ listStyle: 'none', padding: 0, margin: 0 }}
            >
              {notes.map((note, idx) => {
                const key = note.id || `${idx}-${note.createdAt ?? ''}`;
                return (
                  <li
                    key={key}
                    className="rounded-lg border p-3 flex items-start gap-3"
                    style={{ borderColor: 'var(--color-border)' }}
                  >
                    <div className="flex-1 min-w-0">
                      <p
                        className="text-sm m-0"
                        style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}
                      >
                        {note.noteDescription || '(boş)'}
                      </p>
                      {note.createdAt && (
                        <p className="text-muted text-xs m-0" style={{ marginTop: 4 }}>
                          {note.createdAt}
                        </p>
                      )}
                    </div>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={!note.id || deletingId === note.id}
                      onClick={() => handleDelete(note)}
                      title="Notu sil"
                    >
                      {deletingId === note.id ? (
                        <RefreshCw size={14} className="animate-spin" />
                      ) : (
                        <Trash2 size={14} />
                      )}
                    </button>
                  </li>
                );
              })}
            </ul>
          )}
        </section>

        <section>
          <h4 className="text-sm font-semibold mb-2">Yeni Not</h4>
          <div className="form-group" style={{ marginBottom: 8 }}>
            <textarea
              className="form-input"
              rows={3}
              placeholder="Görüşme notunu buraya yazın..."
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              disabled={submitting}
            />
          </div>
          <div className="flex gap-2 justify-end">
            <button
              type="button"
              className="btn btn-secondary"
              onClick={onClose}
              disabled={submitting}
            >
              Kapat
            </button>
            <button
              type="button"
              className="btn btn-primary"
              onClick={handleAdd}
              disabled={submitting || !draft.trim()}
            >
              {submitting ? (
                <>
                  <RefreshCw size={14} className="animate-spin" />
                  İşleniyor...
                </>
              ) : (
                <>
                  <FileText size={14} />
                  Ekle
                </>
              )}
            </button>
          </div>
        </section>
      </div>
    </Modal>
  );
}
