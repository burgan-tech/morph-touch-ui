import { useEffect, useState, useCallback } from 'react';
import {
  Users,
  UserPlus,
  RefreshCw,
  Settings,
  Clock,
  Pencil,
  Trash2,
} from 'lucide-react';
import { listInstances, startInstance, runTransition, getAbsenceEntries } from '../../lib/api';
import { cn } from '../../lib/utils';
import { DAY_LABELS } from '../../lib/constants';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';

const ROLE_OPTIONS = [
  { value: '', label: 'Tümü' },
  { value: 'PY', label: 'PY' },
  { value: 'YD', label: 'YD' },
];

const STATUS_OPTIONS = [
  { value: '', label: 'Tüm' },
  { value: 'online', label: 'Online' },
  { value: 'offline', label: 'Offline' },
  { value: 'busy', label: 'Busy' },
  { value: 'away', label: 'Away' },
];

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string };
  _source?: 'PM' | 'IA';
}

function workflowFor(inst: VnextInstance): string {
  return inst._source === 'IA' ? 'investment-advisor' : 'portfolio-manager';
}

interface ApiData<T> {
  items?: T[];
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function staffRegistryNumber(inst: VnextInstance): string {
  const a = inst.attributes ?? {};
  const reg = (a.registryNumber as string) ?? '';
  if (reg) return reg;
  const first = (a.firstName as string) ?? '';
  const last = (a.lastName as string) ?? '';
  if (first || last) return `${first} ${last}`.trim();
  return '';
}

function staffName(inst: VnextInstance): string {
  return staffRegistryNumber(inst) || (inst.attributes?.advisorId as string) || inst.key || '—';
}

function staffRole(inst: VnextInstance): string {
  const explicit = inst.attributes?.role as string | undefined;
  if (explicit) return explicit;
  if (inst._source === 'IA') return 'YD';
  if (inst._source === 'PM') return 'PY';
  return '—';
}

/** Strips legacy morph-touch.{workflow}. prefix so maps use instance key only (e.g. pm-002). */
function advisorInstanceKey(ref: string): string {
  if (!ref) return ref;
  const pm = 'morph-touch.portfolio-manager.';
  const ia = 'morph-touch.investment-advisor.';
  if (ref.startsWith(pm)) return ref.slice(pm.length);
  if (ref.startsWith(ia)) return ref.slice(ia.length);
  return ref;
}


type TimeRange = { start: string; end: string };
type Schedule = Record<string, TimeRange[]>;

export function StaffManagement() {
  const [staff, setStaff] = useState<VnextInstance[]>([]);
  const [loading, setLoading] = useState(true);
  const [roleFilter, setRoleFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [addModalOpen, setAddModalOpen] = useState(false);
  const [detailModalOpen, setDetailModalOpen] = useState(false);
  const [detailStaff, setDetailStaff] = useState<VnextInstance | null>(null);
  const [addForm, setAddForm] = useState({ registryNumber: '', role: 'PY' });
  const [addLoading, setAddLoading] = useState(false);
  const [deleteLoading, setDeleteLoading] = useState<string | null>(null);
  const [editModalOpen, setEditModalOpen] = useState(false);
  const [editStaff, setEditStaff] = useState<VnextInstance | null>(null);
  const [editForm, setEditForm] = useState({ registryNumber: '', role: '' });
  const [editLoading, setEditLoading] = useState(false);
  const [whMap, setWhMap] = useState<Record<string, Schedule>>({});

  const fetchWorkingHours = useCallback(async () => {
    try {
      const res = await getAbsenceEntries({ absenceType: 'working-hours-change' });
      if (!res.ok || !res.data) return;
      const d = res.data as Record<string, unknown>;
      const items = (d?.items ?? (d?.getAbsenceEntry as Record<string, unknown>)?.items ?? []) as VnextInstance[];
      if (!Array.isArray(items)) return;
      const map: Record<string, Schedule> = {};
      for (const item of items) {
        const wh = item.attributes?.customWorkingHours as Schedule | undefined;
        if (!wh) continue;
        if (item.key === 'working-hour') {
          map['__company__'] = wh;
        } else if (item.key?.startsWith('working-hour-')) {
          const raw =
            (item.attributes?.advisor as string) ?? item.key.replace('working-hour-', '');
          map[advisorInstanceKey(raw)] = wh;
        }
      }
      setWhMap(map);
    } catch { /* ignore */ }
  }, []);

  const getStaffSchedule = useCallback((inst: VnextInstance): Schedule => {
    const advisorId = advisorInstanceKey(
      (inst.attributes?.advisorId as string) ?? inst.key ?? ''
    );
    const instanceKey = advisorInstanceKey(inst.key ?? '');
    return (
      whMap[instanceKey] ?? whMap[advisorId] ?? whMap['__company__'] ?? {}
    );
  }, [whMap]);

  const fetchStaff = useCallback(async () => {
    setLoading(true);
    try {
      const [pmRes, iaRes] = await Promise.all([
        listInstances('portfolio-manager', { pageSize: 100 }),
        listInstances('investment-advisor', { pageSize: 100 }),
      ]);
      const pmItems = extractItems<VnextInstance>(pmRes).map((i) => ({ ...i, _source: 'PM' as const }));
      const iaItems = extractItems<VnextInstance>(iaRes).map((i) => ({ ...i, _source: 'IA' as const }));
      setStaff([...pmItems, ...iaItems]);
      if (!pmRes.ok || !iaRes.ok) {
        const err =
          (pmRes.data as Record<string, unknown>)?.error ??
          (iaRes.data as Record<string, unknown>)?.error;
        toast(String(err ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchStaff();
    fetchWorkingHours();
  }, [fetchStaff, fetchWorkingHours]);

  const filteredStaff = staff.filter((s) => {
    if (roleFilter && staffRole(s) !== roleFilter) return false;
    const state = s.metadata?.currentState ?? '';
    if (statusFilter && state !== statusFilter) return false;
    const name = staffName(s).toLowerCase();
    const advisorId = String(s.attributes?.advisorId ?? '').toLowerCase();
    if (searchQuery) {
      const q = searchQuery.toLowerCase();
      if (!name.includes(q) && !advisorId.includes(q)) return false;
    }
    return true;
  });

  const handleAddStaff = async () => {
    const { registryNumber, role } = addForm;
    const reg = registryNumber.trim();
    if (!reg) {
      toast('Sicil No gerekli', 'error');
      return;
    }
    setAddLoading(true);
    try {
      const workflow = role === 'YD' ? 'investment-advisor' : 'portfolio-manager';
      const key = reg;
      const res = await startInstance(workflow, {
        key,
        tags: ['portfolio-manager'],
        attributes: {
          advisorId: reg,
          registryNumber: reg,
          role: role || undefined,
          user: reg,
        },
      });
      if (res.ok) {
        toast('Personel eklendi', 'success');
        setAddModalOpen(false);
        setAddForm({ registryNumber: '', role: 'PY' });
        fetchStaff();
      } else {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAddLoading(false);
    }
  };

  const handleActivate = async (inst: VnextInstance) => {
    if (!inst.id) return;
    try {
      const res = await runTransition(workflowFor(inst), inst.id, 'activate', {});
      if (res.ok) {
        toast('Aktifleştirildi', 'success');
        fetchStaff();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    }
  };

  const openEdit = (s: VnextInstance) => {
    setEditStaff(s);
    const a = s.attributes ?? {};
    const reg = (a.registryNumber as string)
      || (a.firstName as string ? `${a.firstName ?? ''} ${a.lastName ?? ''}`.trim() : '')
      || (a.advisorId as string)
      || s.key
      || '';
    setEditForm({
      registryNumber: reg,
      role: String(a.role ?? 'PY'),
    });
    setEditModalOpen(true);
  };

  const handleEdit = async () => {
    if (!editStaff?.id) return;
    setEditLoading(true);
    try {
      const res = await runTransition(workflowFor(editStaff), editStaff.id, 'update', {
        attributes: {
          registryNumber: editForm.registryNumber.trim() || undefined,
          role: editForm.role || undefined,
        },
      });
      if (res.ok) {
        toast('Güncellendi', 'success');
        setEditModalOpen(false);
        setEditStaff(null);
        fetchStaff();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setEditLoading(false);
    }
  };

  const handleDeactivate = async (inst: VnextInstance) => {
    if (!inst.id) return;
    setDeleteLoading(inst.id);
    try {
      const res = await runTransition(workflowFor(inst), inst.id, 'deactivate', {});
      if (res.ok) {
        toast('Pasife alındı', 'success');
        fetchStaff();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setDeleteLoading(null);
    }
  };

  const openDetail = (s: VnextInstance) => {
    setDetailStaff(s);
    setDetailModalOpen(true);
  };

  return (
    <div className="page">
      <div className="page-header">
        <h1>Personel Yönetimi</h1>
      </div>
      <div className="page-grid page-grid-full">
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={20} />
              <h3>Personel Listesi</h3>
            </div>
            <div className="flex items-center gap-2">
              <button
                className="btn btn-secondary btn-sm"
                onClick={fetchStaff}
                disabled={loading}
                title="Yenile"
              >
                <RefreshCw size={16} className={cn(loading && 'animate-spin')} />
                Yenile
              </button>
              <button className="btn btn-primary btn-sm" onClick={() => setAddModalOpen(true)}>
                <UserPlus size={16} />
                Yeni Personel Ekle
              </button>
            </div>
          </CardHeader>
          <CardBody>
            <div className="filter-row" style={{ marginBottom: 16 }}>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Rol</label>
                <select
                  className="form-input"
                  value={roleFilter}
                  onChange={(e) => setRoleFilter(e.target.value)}
                  style={{ minWidth: 100 }}
                >
                  {ROLE_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0 }}>
                <label className="form-label">Durum</label>
                <select
                  className="form-input"
                  value={statusFilter}
                  onChange={(e) => setStatusFilter(e.target.value)}
                  style={{ minWidth: 120 }}
                >
                  {STATUS_OPTIONS.map((o) => (
                    <option key={o.value} value={o.value}>
                      {o.label}
                    </option>
                  ))}
                </select>
              </div>
              <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 180 }}>
                <label className="form-label">Ara</label>
                <input
                  type="text"
                  className="form-input"
                  placeholder="Sicil no veya danışman ID..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                />
              </div>
            </div>

            {loading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Yükleniyor...</p>
              </div>
            ) : filteredStaff.length === 0 ? (
              <EmptyState message="Personel bulunamadı" icon={<Users size={40} strokeWidth={1.5} />} />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Sicil No</th>
                      <th>Rol</th>
                      <th>Durum</th>
                      <th>İşlemler</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredStaff.map((s) => {
                      const state = s.metadata?.currentState ?? 'draft';
                      return (
                        <tr key={s.key}>
                          <td>
                            <button
                              type="button"
                              className="text-left font-medium hover:underline"
                              onClick={() => openDetail(s)}
                            >
                              {staffName(s)}
                            </button>
                          </td>
                          <td>{staffRole(s)}</td>
                          <td>
                            <Badge state={state} />
                          </td>
                          <td>
                            <div className="flex gap-2">
                              {state === 'draft' && (
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => handleActivate(s)}
                                >
                                  <Settings size={14} />
                                  Aktifleştir
                                </button>
                              )}
                              {['online', 'offline', 'busy', 'away'].includes(state) && (
                                <>
                                  <button
                                    className="btn btn-secondary btn-sm"
                                    onClick={() => openEdit(s)}
                                  >
                                    <Pencil size={14} />
                                    Düzenle
                                  </button>
                                  <button
                                    className="btn btn-danger btn-sm"
                                    onClick={() => handleDeactivate(s)}
                                    disabled={deleteLoading === s.id}
                                  >
                                    <Trash2 size={14} />
                                    Sil
                                  </button>
                                </>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>
      </div>

      {/* Add Staff Modal */}
      <Modal
        open={addModalOpen}
        onClose={() => setAddModalOpen(false)}
        title="Yeni Personel Ekle"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => setAddModalOpen(false)}>
              İptal
            </button>
            <button
              className="btn btn-primary"
              onClick={handleAddStaff}
              disabled={addLoading}
            >
              {addLoading ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  Ekleniyor...
                </>
              ) : (
                <>
                  <UserPlus size={16} />
                  Ekle
                </>
              )}
            </button>
          </>
        }
      >
        <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <div className="form-group">
            <label className="form-label">Sicil No</label>
            <input
              type="text"
              className="form-input"
              placeholder="ör. 12345"
              value={addForm.registryNumber}
              onChange={(e) => setAddForm((p) => ({ ...p, registryNumber: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Rol</label>
            <select
              className="form-input"
              value={addForm.role}
              onChange={(e) => setAddForm((p) => ({ ...p, role: e.target.value }))}
            >
              <option value="PY">PY</option>
              <option value="YD">YD</option>
            </select>
          </div>
        </div>
      </Modal>

      {/* Staff Detail Modal */}
      <Modal
        open={detailModalOpen}
        onClose={() => { setDetailModalOpen(false); setDetailStaff(null); }}
        title={detailStaff ? staffName(detailStaff) : 'Personel Detayı'}
        footer={null}
      >
        {detailStaff && (
          <div className="flex flex-col gap-4">
            <div>
              <h4 className="text-sm font-medium text-muted mb-2 flex items-center gap-2">
                <Clock size={16} />
                Çalışma Saatleri
              </h4>
              {(() => {
                const wh = getStaffSchedule(detailStaff);
                const days = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'];
                if (Object.keys(wh).length === 0) {
                  return <p className="text-muted text-sm">Tanımlanmamış</p>;
                }
                return (
                  <div className="table-wrapper">
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Gün</th>
                          <th>Başlangıç – Bitiş</th>
                        </tr>
                      </thead>
                      <tbody>
                        {days.map((day) => {
                          const slots = wh[day];
                          const text =
                            !slots || slots.length === 0
                              ? 'Kapalı'
                              : slots.map((s) => `${s.start} – ${s.end}`).join(', ');
                          return (
                            <tr key={day}>
                              <td>{DAY_LABELS[day] ?? day}</td>
                              <td>{text}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                );
              })()}
            </div>
            <div>
              <h4 className="text-sm font-medium text-muted mb-2">Mevcut Durum</h4>
              <Badge state={detailStaff.metadata?.currentState ?? '—'} />
            </div>
          </div>
        )}
      </Modal>

      {/* Edit Staff Modal */}
      <Modal
        open={editModalOpen}
        onClose={() => { setEditModalOpen(false); setEditStaff(null); }}
        title="Personel Düzenle"
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setEditModalOpen(false); setEditStaff(null); }}>
              İptal
            </button>
            <button className="btn btn-primary" onClick={handleEdit} disabled={editLoading}>
              {editLoading ? (
                <>
                  <RefreshCw size={16} className="animate-spin" />
                  Kaydediliyor...
                </>
              ) : (
                <>
                  <Pencil size={16} />
                  Kaydet
                </>
              )}
            </button>
          </>
        }
      >
        <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
          <div className="form-group">
            <label className="form-label">Sicil No</label>
            <input
              type="text"
              className="form-input"
              value={editForm.registryNumber}
              onChange={(e) => setEditForm((p) => ({ ...p, registryNumber: e.target.value }))}
            />
          </div>
          <div className="form-group">
            <label className="form-label">Rol</label>
            <select
              className="form-input"
              value={editForm.role}
              onChange={(e) => setEditForm((p) => ({ ...p, role: e.target.value }))}
            >
              <option value="PY">PY</option>
              <option value="YD">YD</option>
            </select>
          </div>
        </div>
      </Modal>
    </div>
  );
}
