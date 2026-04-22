export function formatDateTime(iso?: string): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return d.toLocaleString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });
}

export function formatDate(ts?: string | number): string {
  if (ts == null || ts === '') return '—';
  const n = typeof ts === 'number' ? ts : Number(ts);
  const d = isNaN(n) ? new Date(ts as string) : new Date(n);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleDateString('tr-TR', { day: '2-digit', month: '2-digit', year: 'numeric' });
}

export function formatTime(ts?: string | number): string {
  if (ts == null || ts === '') return '—';
  const n = typeof ts === 'number' ? ts : Number(ts);
  const d = isNaN(n) ? new Date(ts as string) : new Date(n);
  if (isNaN(d.getTime())) return '—';
  return d.toLocaleTimeString('tr-TR', { hour: '2-digit', minute: '2-digit' });
}

export function formatDuration(startIso?: string, endIso?: string): string {
  if (!startIso || !endIso) return '—';
  const mins = Math.round((new Date(endIso).getTime() - new Date(startIso).getTime()) / 60000);
  if (mins < 1) return '< 1 dk';
  if (mins < 60) return `${mins} dk`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return m ? `${h} saat ${m} dk` : `${h} saat`;
}

/** `datetime-local` value or `YYYY-MM-DDTHH:mm` → UTC ISO-8601 with `Z`. */
export function toUtcIsoFromLocalInput(value: string): string {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d.toISOString();
}

/** `YYYY-MM-DD` + slot time (`HH:mm` or `HH:mm:ss`) in local TZ → UTC ISO with `Z`. */
export function toUtcIsoFromDateAndTime(date: string, time: string): string {
  const t = time.length === 5 ? `${time}:00` : time;
  const d = new Date(`${date}T${t}`);
  if (Number.isNaN(d.getTime())) throw new Error('Invalid date');
  return d.toISOString();
}

/** Stable key segment from UTC ISO (e.g. transfer keys). */
export function utcIsoToTransferKeySegment(iso: string): string {
  return iso.slice(0, 19).replace('T', '-').replace(/:/g, '-');
}

export function cn(...classes: (string | false | null | undefined)[]): string {
  return classes.filter(Boolean).join(' ');
}

export function timeUntil(iso: string): string {
  const diff = new Date(iso).getTime() - Date.now();
  if (diff < 0) return 'Geçmiş';
  const mins = Math.floor(diff / 60000);
  if (mins < 60) return `${mins} dk`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} saat`;
  return `${Math.floor(hours / 24)} gün`;
}

export function getStateBadgeColor(state: string): string {
  const map: Record<string, string> = {
    active: 'var(--color-success)',
    online: 'var(--color-success)',
    'in-meet': 'var(--color-warning)',
    busy: 'var(--color-warning)',
    'meet-completed': 'var(--color-info)',
    complete: 'var(--color-info)',
    completed: 'var(--color-info)',
    cancelled: 'var(--color-muted)',
    'user-cancelled': 'var(--color-danger)',
    'advisor-cancelled': 'var(--color-danger)',
    timeout: 'var(--color-danger)',
    failed: 'var(--color-danger)',
    offline: 'var(--color-muted)',
    away: 'var(--color-warning)',
    draft: 'var(--color-muted)',
  };
  return map[state] || 'var(--color-muted)';
}
