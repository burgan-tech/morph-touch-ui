import { useEffect, useState, useCallback } from 'react';
import { Video, Search, RefreshCw, User } from 'lucide-react';
import { getReservations } from '../../lib/api';
import { formatDateTime, formatDuration, cn } from '../../lib/utils';
import { Badge, Card, CardHeader, CardBody, EmptyState, toast } from '../../components/ui';

interface ReservationInstance {
  key: string;
  id?: string;
  attributes: {
    user?: unknown;
    advisor?: unknown;
    startDateTime?: string;
    endDateTime?: string;
  };
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  getRezervations?: { items?: T[] };
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getRezervations?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function refDisplay(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

export function VideoRecords() {
  const [loading, setLoading] = useState(true);
  const [reservations, setReservations] = useState<ReservationInstance[]>([]);
  const [customerFilter, setCustomerFilter] = useState('');
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [appliedFilters, setAppliedFilters] = useState<{
    customer: string;
    startDate: string;
    endDate: string;
  }>({ customer: '', startDate: '', endDate: '' });

  const fetchReservations = useCallback(async () => {
    setLoading(true);
    try {
      const headers: Record<string, string> = { touchUser: 'admin', userType: 'admin' };
      if (appliedFilters.startDate) headers.startDate = appliedFilters.startDate;
      if (appliedFilters.endDate) headers.endDate = appliedFilters.endDate;

      const res = await getReservations(headers);
      const items = extractItems<ReservationInstance>(res);
      setReservations(items);

      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, [appliedFilters.startDate, appliedFilters.endDate]);

  useEffect(() => {
    fetchReservations();
  }, [fetchReservations]);

  const handleSearch = () => {
    setAppliedFilters({
      customer: customerFilter.trim(),
      startDate,
      endDate,
    });
  };

  const completedReservations = reservations.filter((r) => {
    const s = r.metadata?.currentState ?? '';
    if (!['meet-completed', 'complete', 'completed'].includes(s)) return false;

    const customer = refDisplay(r.attributes?.user).toLowerCase();
    const customerMatch =
      !appliedFilters.customer ||
      customer.includes(appliedFilters.customer.toLowerCase());

    const start = r.attributes?.startDateTime ?? '';
    const dateMatch =
      (!appliedFilters.startDate || start >= appliedFilters.startDate) &&
      (!appliedFilters.endDate || start.slice(0, 10) <= appliedFilters.endDate);

    return customerMatch && dateMatch;
  });

  return (
    <div className="page">
      <div className="page-header">
        <h1>Görüntülü Görüşme Kayıtları</h1>
      </div>
      <div className="page-grid page-grid-full">
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <Video size={20} />
              <h3>Kayıtlar</h3>
            </div>
          </CardHeader>
          <CardBody>
            <div className="form-row">
              <div className="form-group">
                <label className="form-label">TCKN / Müşteri No</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Müşteri ID veya TCKN"
                  value={customerFilter}
                  onChange={(e) => setCustomerFilter(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Başlangıç Tarihi</label>
                <input
                  type="date"
                  className="form-input"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Bitiş Tarihi</label>
                <input
                  type="date"
                  className="form-input"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                />
              </div>
              <button className="btn btn-primary" onClick={handleSearch}>
                <Search size={16} />
                Ara
              </button>
              <button
                type="button"
                className="btn btn-secondary"
                onClick={fetchReservations}
                disabled={loading}
              >
                <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
                Yenile
              </button>
            </div>

            {loading ? (
              <div className="empty-state">
                <div
                  className="animate-spin"
                  style={{
                    width: 32,
                    height: 32,
                    border: '3px solid var(--color-border)',
                    borderTopColor: 'var(--color-primary)',
                    borderRadius: '50%',
                  }}
                />
                <p>Yükleniyor...</p>
              </div>
            ) : completedReservations.length === 0 ? (
              <EmptyState
                message="Kayıt bulunamadı"
                icon={<Video size={40} strokeWidth={1.5} />}
              />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tarih</th>
                      <th>Danışman</th>
                      <th>Müşteri</th>
                      <th>Süre</th>
                      <th>Durum</th>
                      <th>Kayıt</th>
                    </tr>
                  </thead>
                  <tbody>
                    {completedReservations.map((r) => (
                      <tr key={r.id ?? r.key}>
                        <td className="text-sm">
                          {formatDateTime(r.attributes?.startDateTime)}
                        </td>
                        <td>
                          <div className="flex items-center gap-2">
                            <User size={14} className="text-muted" />
                            {refDisplay(r.attributes?.advisor)}
                          </div>
                        </td>
                        <td>{refDisplay(r.attributes?.user)}</td>
                        <td className="text-sm">
                          {formatDuration(
                            r.attributes?.startDateTime,
                            r.attributes?.endDateTime
                          )}
                        </td>
                        <td>
                          <Badge state={r.metadata?.currentState ?? ''} />
                        </td>
                        <td>
                          <span
                            className="badge badge-sm"
                            style={
                              {
                                '--badge-color': 'var(--color-muted)',
                              } as React.CSSProperties
                            }
                          >
                            Kayıt Mevcut
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>
    </div>
  );
}
