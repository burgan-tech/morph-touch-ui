import { useEffect, useState, useCallback } from 'react';
import {
  Plus,
  RefreshCw,
  Settings,
  Pencil,
  XCircle,
  CalendarCheck,
  Trash2,
  Check,
  X,
  Users,
  Clock,
  Copy,
} from 'lucide-react';
import {
  getAbsenceEntries,
  startInstance,
  runTransition,
  listInstances,
} from '../../lib/api';
import { formatDateTime } from '../../lib/utils';
import { DAY_LABELS } from '../../lib/constants';
import { Badge, Card, CardHeader, CardBody, EmptyState, Modal, toast } from '../../components/ui';

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
  _source?: 'PM' | 'IA';
}

interface ApiData<T> {
  items?: T[];
  getAbsenceEntry?: { items?: T[] };
  [key: string]: unknown;
}

function extractItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getAbsenceEntry?.items ?? (d?.data as ApiData<T>)?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function advisorDisplayName(inst: VnextInstance): string {
  const a = inst.attributes ?? {};
  return (a.registryNumber as string) || (a.advisorId as string) || inst.key || '—';
}

function fullAdvisorRef(inst: VnextInstance): string {
  const wf = inst._source === 'IA' ? 'investment-advisor' : 'portfolio-manager';
  return `morph-touch.${wf}.${inst.key}`;
}

function advisorRole(inst: VnextInstance): string {
  if (inst._source === 'IA') return 'YD';
  if (inst._source === 'PM') return 'PY';
  return '—';
}

export function AbsenceManagement() {

  type TimeRange = { start: string; end: string };
  type WeekSchedule = Record<string, TimeRange[]>;
  const DAYS = ['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const;
  const defaultSchedule: WeekSchedule = Object.fromEntries(DAYS.map((d) => [d, []]));

  const [companyHours, setCompanyHours] = useState<WeekSchedule>(defaultSchedule);
  const [companyEntry, setCompanyEntry] = useState<VnextInstance | null>(null);
  const [companyHoursLoading, setCompanyHoursLoading] = useState(true);
  const [companyHoursSaving, setCompanyHoursSaving] = useState(false);
  const [companyHoursEditing, setCompanyHoursEditing] = useState(false);
  const [editingHours, setEditingHours] = useState<WeekSchedule>(defaultSchedule);

  const [holidays, setHolidays] = useState<VnextInstance[]>([]);
  const [holidaysLoading, setHolidaysLoading] = useState(true);
  const [holidayForm, setHolidayForm] = useState({ title: '', startDateTime: '', endDateTime: '' });
  const [holidaySaving, setHolidaySaving] = useState(false);
  const [holidayCancelling, setHolidayCancelling] = useState<string | null>(null);
  const [editingHoliday, setEditingHoliday] = useState<VnextInstance | null>(null);
  const [editForm, setEditForm] = useState({ title: '', startDateTime: '', endDateTime: '' });
  const [holidayUpdating, setHolidayUpdating] = useState(false);

  const [advisors, setAdvisors] = useState<VnextInstance[]>([]);
  const [advisorsLoading, setAdvisorsLoading] = useState(true);
  const [advisorWhEntries, setAdvisorWhEntries] = useState<Record<string, VnextInstance>>({});
  const [advisorWhModalOpen, setAdvisorWhModalOpen] = useState(false);
  const [selectedAdvisor, setSelectedAdvisor] = useState<VnextInstance | null>(null);
  const [advisorEditHours, setAdvisorEditHours] = useState<WeekSchedule>(defaultSchedule);
  const [advisorWhSaving, setAdvisorWhSaving] = useState(false);
  const [advisorSearch, setAdvisorSearch] = useState('');
  const [advisorCancelling, setAdvisorCancelling] = useState<string | null>(null);

  /* ── Fetch all working-hours entries (company + advisor) ── */

  const fetchAllWorkingHours = useCallback(async () => {
    setCompanyHoursLoading(true);
    try {
      const filter = JSON.stringify({
        and: [{ attributes: { absenceType: { eq: 'working-hours-change' } } }],
      });
      const res = await listInstances('absence-entry', { currentState: 'complete', pageSize: 100, filter });
      const items = extractItems<VnextInstance>(res);

      const company = items.find((i) => i.key === 'working-hour');
      setCompanyEntry(company ?? null);
      if (company?.attributes?.customWorkingHours) {
        setCompanyHours(company.attributes.customWorkingHours as WeekSchedule);
      }

      const advMap: Record<string, VnextInstance> = {};
      for (const item of items) {
        if (item.key?.startsWith('working-hour-') && item.key !== 'working-hour') {
          let shortKey = item.key.replace('working-hour-', '');
          shortKey = shortKey.replace(/^morph-touch\.(portfolio-manager|investment-advisor)\./, '');
          advMap[shortKey] = item;
        }
      }
      setAdvisorWhEntries(advMap);
    } catch {
      /* ignore */
    } finally {
      setCompanyHoursLoading(false);
    }
  }, []);

  /* ── Fetch advisor list (PM + IA) ── */

  const fetchAdvisors = useCallback(async () => {
    setAdvisorsLoading(true);
    try {
      const [pmRes, iaRes] = await Promise.all([
        listInstances('portfolio-manager', { pageSize: 100 }),
        listInstances('investment-advisor', { pageSize: 100 }),
      ]);
      const pmItems = extractItems<VnextInstance>(pmRes).map((i) => ({ ...i, _source: 'PM' as const }));
      const iaItems = extractItems<VnextInstance>(iaRes).map((i) => ({ ...i, _source: 'IA' as const }));
      setAdvisors([...pmItems, ...iaItems]);
    } catch {
      /* ignore */
    } finally {
      setAdvisorsLoading(false);
    }
  }, []);

  /* ── Company hours save ── */

  const saveCompanyHours = async () => {
    setCompanyHoursSaving(true);
    try {
      const payload = {
        absenceType: 'working-hours-change',
        title: 'Şirket Çalışma Saatleri',
        customWorkingHours: editingHours,
      };
      let res: { ok: boolean; data?: unknown };
      if (companyEntry?.id) {
        res = await runTransition('absence-entry', companyEntry.id, 'update', {
          attributes: payload,
        });
      } else {
        res = await startInstance('absence-entry', {
          key: 'working-hour',
          tags: ['working-hours-change', 'company'],
          attributes: payload,
        });
      }
      if (res.ok) {
        toast('Çalışma saatleri kaydedildi', 'success');
        setCompanyHours(editingHours);
        setCompanyHoursEditing(false);
        await fetchAllWorkingHours();
      } else {
        const err = (res.data as Record<string, unknown>)?.detail ??
          (res.data as Record<string, unknown>)?.error ?? 'Kaydetme hatası';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setCompanyHoursSaving(false);
    }
  };

  useEffect(() => {
    fetchAllWorkingHours();
    fetchAdvisors();
  }, [fetchAllWorkingHours, fetchAdvisors]);

  /* ── Holidays ── */

  const fetchHolidays = useCallback(async () => {
    setHolidaysLoading(true);
    try {
      const res = await getAbsenceEntries({ absenceType: 'public-holiday' });
      const items = extractItems<VnextInstance>(res);
      setHolidays(items.sort((a, b) =>
        String(a.attributes?.startDateTime ?? '').localeCompare(String(b.attributes?.startDateTime ?? ''))
      ));
    } catch {
      setHolidays([]);
    } finally {
      setHolidaysLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHolidays();
  }, [fetchHolidays]);

  const addHoliday = async () => {
    const { title, startDateTime, endDateTime } = holidayForm;
    if (!title.trim() || !startDateTime || !endDateTime) {
      toast('Başlık, başlangıç ve bitiş tarihi gerekli', 'error');
      return;
    }
    setHolidaySaving(true);
    try {
      const dateKey = startDateTime.slice(0, 10);
      const res = await startInstance('absence-entry', {
        key: `public-holiday-${dateKey}`,
        tags: ['public-holiday'],
        attributes: {
          absenceType: 'public-holiday',
          startDateTime: new Date(startDateTime).toISOString(),
          endDateTime: new Date(endDateTime).toISOString(),
          title: title.trim(),
        },
      });
      if (res.ok) {
        toast('Resmi tatil eklendi', 'success');
        setHolidayForm({ title: '', startDateTime: '', endDateTime: '' });
        fetchHolidays();
      } else {
        const err = (res.data as Record<string, unknown>)?.detail ??
          (res.data as Record<string, unknown>)?.error ?? 'Ekleme hatası';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setHolidaySaving(false);
    }
  };

  const cancelHoliday = async (inst: VnextInstance) => {
    if (!inst.id) return;
    setHolidayCancelling(inst.id);
    try {
      const res = await runTransition('absence-entry', inst.id, 'cancel', {});
      if (res.ok) {
        toast('Tatil iptal edildi', 'success');
        fetchHolidays();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setHolidayCancelling(null);
    }
  };

  const toLocalInput = (iso: string): string => {
    if (!iso) return '';
    const d = new Date(iso);
    const pad = (n: number) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };

  const startEditHoliday = (inst: VnextInstance) => {
    setEditingHoliday(inst);
    setEditForm({
      title: (inst.attributes?.title as string) ?? '',
      startDateTime: toLocalInput((inst.attributes?.startDateTime as string) ?? ''),
      endDateTime: toLocalInput((inst.attributes?.endDateTime as string) ?? ''),
    });
  };

  const updateHoliday = async () => {
    if (!editingHoliday?.id) return;
    const { title, startDateTime, endDateTime } = editForm;
    if (!title.trim() || !startDateTime || !endDateTime) {
      toast('Başlık, başlangıç ve bitiş tarihi gerekli', 'error');
      return;
    }
    setHolidayUpdating(true);
    try {
      const res = await runTransition('absence-entry', editingHoliday.id, 'update', {
        attributes: {
          absenceType: 'public-holiday',
          title: title.trim(),
          startDateTime: new Date(startDateTime).toISOString(),
          endDateTime: new Date(endDateTime).toISOString(),
        },
      });
      if (res.ok) {
        toast('Tatil güncellendi', 'success');
        setEditingHoliday(null);
        fetchHolidays();
      } else {
        const err = (res.data as Record<string, unknown>)?.detail ??
          (res.data as Record<string, unknown>)?.error ?? 'Güncelleme hatası';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setHolidayUpdating(false);
    }
  };

  /* ── Company hours editing helpers ── */

  const startEditingHours = () => {
    setEditingHours(JSON.parse(JSON.stringify(companyHours)));
    setCompanyHoursEditing(true);
  };

  const updateSlot = (day: string, idx: number, field: 'start' | 'end', value: string) => {
    setEditingHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      if (copy[day]?.[idx]) copy[day][idx][field] = value;
      return copy;
    });
  };

  const addSlot = (day: string) => {
    setEditingHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      if (!copy[day]) copy[day] = [];
      copy[day].push({ start: '09:00', end: '18:00' });
      return copy;
    });
  };

  const removeSlot = (day: string, idx: number) => {
    setEditingHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      copy[day]?.splice(idx, 1);
      return copy;
    });
  };

  /* ── Advisor working-hours handlers ── */

  const openAdvisorWhModal = (advisor: VnextInstance) => {
    setSelectedAdvisor(advisor);
    const existing = advisorWhEntries[advisor.key];
    if (existing?.attributes?.customWorkingHours) {
      setAdvisorEditHours(JSON.parse(JSON.stringify(existing.attributes.customWorkingHours)));
    } else {
      setAdvisorEditHours(JSON.parse(JSON.stringify(companyHours)));
    }
    setAdvisorWhModalOpen(true);
  };

  const copyCompanyToAdvisor = () => {
    setAdvisorEditHours(JSON.parse(JSON.stringify(companyHours)));
  };

  const saveAdvisorHours = async () => {
    if (!selectedAdvisor) return;
    setAdvisorWhSaving(true);
    try {
      const advisorKey = selectedAdvisor.key;
      const existing = advisorWhEntries[advisorKey];
      const name = advisorDisplayName(selectedAdvisor);
      const payload = {
        advisor: selectedAdvisor.key,
        absenceType: 'working-hours-change',
        title: `${name} Özel Çalışma Saatleri`,
        customWorkingHours: advisorEditHours,
      };
      let res: { ok: boolean; data?: unknown };
      if (existing?.id) {
        res = await runTransition('absence-entry', existing.id, 'update', { attributes: payload });
      } else {
        res = await startInstance('absence-entry', {
          key: `working-hour-${advisorKey}`,
          tags: ['working-hours-change', 'advisor'],
          attributes: payload,
        });
      }
      if (res.ok) {
        toast('Danışman çalışma saatleri kaydedildi', 'success');
        setAdvisorWhModalOpen(false);
        setSelectedAdvisor(null);
        await fetchAllWorkingHours();
      } else {
        const err = (res.data as Record<string, unknown>)?.detail ??
          (res.data as Record<string, unknown>)?.error ?? 'Kaydetme hatası';
        toast(String(err), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAdvisorWhSaving(false);
    }
  };

  const cancelAdvisorHours = async (advisor: VnextInstance) => {
    const entry = advisorWhEntries[advisor.key];
    if (!entry?.id) return;
    setAdvisorCancelling(entry.id);
    try {
      const res = await runTransition('absence-entry', entry.id, 'cancel', { attributes: {} });
      if (res.ok) {
        toast('Danışman özel çalışma saatleri kaldırıldı', 'success');
        await fetchAllWorkingHours();
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? 'Hata'), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAdvisorCancelling(null);
    }
  };

  const updateAdvisorSlot = (day: string, idx: number, field: 'start' | 'end', value: string) => {
    setAdvisorEditHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      if (copy[day]?.[idx]) copy[day][idx][field] = value;
      return copy;
    });
  };

  const addAdvisorSlot = (day: string) => {
    setAdvisorEditHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      if (!copy[day]) copy[day] = [];
      copy[day].push({ start: '09:00', end: '18:00' });
      return copy;
    });
  };

  const removeAdvisorSlot = (day: string, idx: number) => {
    setAdvisorEditHours((prev) => {
      const copy = JSON.parse(JSON.stringify(prev)) as WeekSchedule;
      copy[day]?.splice(idx, 1);
      return copy;
    });
  };

  const filteredAdvisors = advisors.filter((a) => {
    if (!advisorSearch) return true;
    const q = advisorSearch.toLowerCase();
    return advisorDisplayName(a).toLowerCase().includes(q) || advisorRole(a).toLowerCase().includes(q);
  });

  /* ── Render ── */

  return (
    <div className="page">
      <div className="page-header">
        <h1>Çalışma Saatleri Yönetimi</h1>
      </div>
      <div className="page-grid page-grid-full">

        {/* ── Şirket Çalışma Saatleri ── */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Settings size={20} />
              <h3>Şirket Çalışma Saatleri</h3>
            </div>
            {!companyHoursEditing && (
              <button className="btn btn-primary btn-sm" onClick={startEditingHours} disabled={companyHoursLoading}>
                <Pencil size={16} />
                Düzenle
              </button>
            )}
          </CardHeader>
          <CardBody>
            {companyHoursLoading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Çalışma saatleri yükleniyor...</p>
              </div>
            ) : companyHoursEditing ? (
              <>
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Gün</th>
                        <th>Zaman Aralıkları</th>
                        <th style={{ width: 80 }}></th>
                      </tr>
                    </thead>
                    <tbody>
                      {DAYS.map((day) => {
                        const slots = editingHours[day] ?? [];
                        return (
                          <tr key={day}>
                            <td className="font-medium">{DAY_LABELS[day]}</td>
                            <td>
                              {slots.length === 0 ? (
                                <span className="text-muted text-sm">Kapalı</span>
                              ) : (
                                <div className="flex flex-col gap-2">
                                  {slots.map((slot, idx) => (
                                    <div key={idx} className="flex items-center gap-2">
                                      <input
                                        type="time"
                                        className="form-input"
                                        value={slot.start}
                                        onChange={(e) => updateSlot(day, idx, 'start', e.target.value)}
                                        style={{ width: 120 }}
                                      />
                                      <span>–</span>
                                      <input
                                        type="time"
                                        className="form-input"
                                        value={slot.end}
                                        onChange={(e) => updateSlot(day, idx, 'end', e.target.value)}
                                        style={{ width: 120 }}
                                      />
                                      <button
                                        className="btn btn-danger btn-sm"
                                        onClick={() => removeSlot(day, idx)}
                                        title="Kaldır"
                                      >
                                        <XCircle size={14} />
                                      </button>
                                    </div>
                                  ))}
                                </div>
                              )}
                            </td>
                            <td>
                              <button className="btn btn-secondary btn-sm" onClick={() => addSlot(day)}>
                                <Plus size={14} />
                              </button>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="flex gap-2" style={{ marginTop: 16 }}>
                  <button className="btn btn-primary" onClick={saveCompanyHours} disabled={companyHoursSaving}>
                    {companyHoursSaving ? (
                      <><RefreshCw size={16} className="animate-spin" /> Kaydediliyor...</>
                    ) : 'Kaydet'}
                  </button>
                  <button className="btn btn-secondary" onClick={() => setCompanyHoursEditing(false)}>İptal</button>
                </div>
              </>
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Gün</th>
                      <th>Çalışma Saatleri</th>
                    </tr>
                  </thead>
                  <tbody>
                    {DAYS.map((day) => {
                      const slots = companyHours[day] ?? [];
                      const text = slots.length === 0
                        ? 'Kapalı'
                        : slots.map((s) => `${s.start} – ${s.end}`).join(', ');
                      return (
                        <tr key={day}>
                          <td className="font-medium">{DAY_LABELS[day]}</td>
                          <td>{text}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </CardBody>
        </Card>

        {/* ── Danışmana Özel Çalışma Saatleri ── */}
        <Card>
          <CardHeader className="flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Users size={20} />
              <h3>Danışmana Özel Çalışma Saatleri</h3>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={() => { fetchAdvisors(); fetchAllWorkingHours(); }}
              disabled={advisorsLoading}
              title="Yenile"
            >
              <RefreshCw size={16} className={advisorsLoading ? 'animate-spin' : ''} />
              Yenile
            </button>
          </CardHeader>
          <CardBody>
            {advisorsLoading || companyHoursLoading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Danışmanlar yükleniyor...</p>
              </div>
            ) : advisors.length === 0 ? (
              <EmptyState message="Tanımlı danışman bulunamadı" icon={<Users size={40} strokeWidth={1.5} />} />
            ) : (
              <>
                <div style={{ marginBottom: 16 }}>
                  <input
                    type="text"
                    className="form-input"
                    placeholder="Danışman ara..."
                    value={advisorSearch}
                    onChange={(e) => setAdvisorSearch(e.target.value)}
                    style={{ maxWidth: 300 }}
                  />
                </div>
                <div className="table-wrapper">
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Danışman</th>
                        <th>Rol</th>
                        <th>Çalışma Saati</th>
                        <th style={{ width: 220 }}>İşlemler</th>
                      </tr>
                    </thead>
                    <tbody>
                      {filteredAdvisors.map((a) => {
                        const entry = advisorWhEntries[a.key];
                        const hasCustom = !!entry;
                        return (
                          <tr key={a.key + (a._source ?? '')}>
                            <td className="font-medium">{advisorDisplayName(a)}</td>
                            <td><Badge state={advisorRole(a)} /></td>
                            <td>
                              {hasCustom ? (
                                <span className="flex items-center gap-1">
                                  <Clock size={14} />
                                  <span style={{ color: 'var(--color-primary)' }}>Özel Tanımlı</span>
                                </span>
                              ) : (
                                <span className="text-muted">Şirket Varsayılanı</span>
                              )}
                            </td>
                            <td>
                              <div className="flex gap-2">
                                <button
                                  className="btn btn-primary btn-sm"
                                  onClick={() => openAdvisorWhModal(a)}
                                >
                                  {hasCustom ? <><Pencil size={14} /> Düzenle</> : <><Plus size={14} /> Tanımla</>}
                                </button>
                                {hasCustom && (
                                  <button
                                    className="btn btn-danger btn-sm"
                                    onClick={() => cancelAdvisorHours(a)}
                                    disabled={advisorCancelling === entry?.id}
                                  >
                                    <Trash2 size={14} /> Kaldır
                                  </button>
                                )}
                              </div>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </>
            )}
          </CardBody>
        </Card>

        {/* ── Resmi Tatiller ── */}
        <Card>
          <CardHeader>
            <div className="flex items-center gap-2">
              <CalendarCheck size={20} />
              <h3>Resmi Tatiller</h3>
            </div>
          </CardHeader>
          <CardBody>
            {holidaysLoading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Tatiller yükleniyor...</p>
              </div>
            ) : (
              <>
                {holidays.length === 0 ? (
                  <EmptyState message="Tanımlı resmi tatil yok" icon={<CalendarCheck size={40} strokeWidth={1.5} />} />
                ) : (
                  <div className="table-wrapper" style={{ marginBottom: 20 }}>
                    <table className="table">
                      <thead>
                        <tr>
                          <th>Başlangıç – Bitiş</th>
                          <th>Başlık</th>
                          <th>Durum</th>
                          <th style={{ width: 120 }}>İşlem</th>
                        </tr>
                      </thead>
                      <tbody>
                        {holidays.map((h) => {
                          const st = h.metadata?.currentState ?? '';
                          const isCancelled = st === 'cancelled';
                          const isEditing = editingHoliday?.id === h.id;

                          if (isEditing) {
                            return (
                              <tr key={h.key}>
                                <td>
                                  <div style={{ display: 'flex', gap: 6 }}>
                                    <input
                                      type="datetime-local"
                                      className="form-input"
                                      style={{ fontSize: 12, padding: '2px 4px' }}
                                      value={editForm.startDateTime}
                                      onChange={(e) => setEditForm((p) => ({ ...p, startDateTime: e.target.value }))}
                                    />
                                    <span style={{ alignSelf: 'center' }}>–</span>
                                    <input
                                      type="datetime-local"
                                      className="form-input"
                                      style={{ fontSize: 12, padding: '2px 4px' }}
                                      value={editForm.endDateTime}
                                      onChange={(e) => setEditForm((p) => ({ ...p, endDateTime: e.target.value }))}
                                    />
                                  </div>
                                </td>
                                <td>
                                  <input
                                    type="text"
                                    className="form-input"
                                    style={{ fontSize: 13, padding: '2px 6px' }}
                                    value={editForm.title}
                                    onChange={(e) => setEditForm((p) => ({ ...p, title: e.target.value }))}
                                  />
                                </td>
                                <td><Badge state={st} /></td>
                                <td>
                                  <div style={{ display: 'flex', gap: 4 }}>
                                    <button
                                      className="btn btn-primary btn-sm"
                                      onClick={updateHoliday}
                                      disabled={holidayUpdating}
                                      title="Kaydet"
                                    >
                                      <Check size={14} />
                                    </button>
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => setEditingHoliday(null)}
                                      disabled={holidayUpdating}
                                      title="Vazgeç"
                                    >
                                      <X size={14} />
                                    </button>
                                  </div>
                                </td>
                              </tr>
                            );
                          }

                          const startDt = h.attributes?.startDateTime as string;
                          const endDt = h.attributes?.endDateTime as string;
                          return (
                            <tr key={h.key} style={isCancelled ? { opacity: 0.5 } : undefined}>
                              <td className="text-sm">
                                {formatDateTime(startDt)} – {formatDateTime(endDt)}
                              </td>
                              <td>{(h.attributes?.title as string) ?? h.key}</td>
                              <td><Badge state={st} /></td>
                              <td>
                                {!isCancelled && (
                                  <div style={{ display: 'flex', gap: 4 }}>
                                    <button
                                      className="btn btn-sm"
                                      onClick={() => startEditHoliday(h)}
                                      title="Düzenle"
                                    >
                                      <Pencil size={14} />
                                    </button>
                                    <button
                                      className="btn btn-danger btn-sm"
                                      onClick={() => cancelHoliday(h)}
                                      disabled={holidayCancelling === h.id}
                                      title="İptal Et"
                                    >
                                      <Trash2 size={14} />
                                    </button>
                                  </div>
                                )}
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                <div style={{ borderTop: '1px solid var(--color-border)', paddingTop: 16 }}>
                  <h4 className="text-sm font-medium" style={{ marginBottom: 12 }}>Yeni Resmi Tatil Ekle</h4>
                  <div className="form-row" style={{ flexWrap: 'wrap', gap: 12, alignItems: 'flex-end' }}>
                    <div className="form-group" style={{ marginBottom: 0, flex: 2, minWidth: 180 }}>
                      <label className="form-label">Başlık</label>
                      <input
                        type="text"
                        className="form-input"
                        placeholder="ör. 29 Ekim Cumhuriyet Bayramı"
                        value={holidayForm.title}
                        onChange={(e) => setHolidayForm((p) => ({ ...p, title: e.target.value }))}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                      <label className="form-label">Başlangıç</label>
                      <input
                        type="datetime-local"
                        className="form-input"
                        value={holidayForm.startDateTime}
                        onChange={(e) => setHolidayForm((p) => ({ ...p, startDateTime: e.target.value }))}
                      />
                    </div>
                    <div className="form-group" style={{ marginBottom: 0, flex: 1, minWidth: 160 }}>
                      <label className="form-label">Bitiş</label>
                      <input
                        type="datetime-local"
                        className="form-input"
                        value={holidayForm.endDateTime}
                        onChange={(e) => setHolidayForm((p) => ({ ...p, endDateTime: e.target.value }))}
                      />
                    </div>
                    <button
                      className="btn btn-primary btn-sm"
                      onClick={addHoliday}
                      disabled={holidaySaving}
                      style={{ height: 36 }}
                    >
                      {holidaySaving ? (
                        <><RefreshCw size={14} className="animate-spin" /> Ekleniyor...</>
                      ) : (
                        <><Plus size={14} /> Ekle</>
                      )}
                    </button>
                  </div>
                </div>
              </>
            )}
          </CardBody>
        </Card>

      </div>

      {/* ── Danışman Çalışma Saatleri Modal ── */}
      <Modal
        open={advisorWhModalOpen}
        onClose={() => { setAdvisorWhModalOpen(false); setSelectedAdvisor(null); }}
        title={selectedAdvisor ? `${advisorDisplayName(selectedAdvisor)} – Özel Çalışma Saatleri` : 'Özel Çalışma Saatleri'}
        footer={
          <>
            <button className="btn btn-secondary" onClick={() => { setAdvisorWhModalOpen(false); setSelectedAdvisor(null); }}>
              İptal
            </button>
            <button className="btn btn-primary" onClick={saveAdvisorHours} disabled={advisorWhSaving}>
              {advisorWhSaving ? (
                <><RefreshCw size={16} className="animate-spin" /> Kaydediliyor...</>
              ) : 'Kaydet'}
            </button>
          </>
        }
      >
        <div style={{ marginBottom: 16 }}>
          <button className="btn btn-secondary btn-sm" onClick={copyCompanyToAdvisor}>
            <Copy size={14} /> Şirket Varsayılanını Kopyala
          </button>
        </div>
        <div className="table-wrapper">
          <table className="table">
            <thead>
              <tr>
                <th>Gün</th>
                <th>Zaman Aralıkları</th>
                <th style={{ width: 80 }}></th>
              </tr>
            </thead>
            <tbody>
              {DAYS.map((day) => {
                const slots = advisorEditHours[day] ?? [];
                return (
                  <tr key={day}>
                    <td className="font-medium">{DAY_LABELS[day]}</td>
                    <td>
                      {slots.length === 0 ? (
                        <span className="text-muted text-sm">Kapalı</span>
                      ) : (
                        <div className="flex flex-col gap-2">
                          {slots.map((slot, idx) => (
                            <div key={idx} className="flex items-center gap-2">
                              <input
                                type="time"
                                className="form-input"
                                value={slot.start}
                                onChange={(e) => updateAdvisorSlot(day, idx, 'start', e.target.value)}
                                style={{ width: 120 }}
                              />
                              <span>–</span>
                              <input
                                type="time"
                                className="form-input"
                                value={slot.end}
                                onChange={(e) => updateAdvisorSlot(day, idx, 'end', e.target.value)}
                                style={{ width: 120 }}
                              />
                              <button
                                className="btn btn-danger btn-sm"
                                onClick={() => removeAdvisorSlot(day, idx)}
                                title="Kaldır"
                              >
                                <XCircle size={14} />
                              </button>
                            </div>
                          ))}
                        </div>
                      )}
                    </td>
                    <td>
                      <button className="btn btn-secondary btn-sm" onClick={() => addAdvisorSlot(day)}>
                        <Plus size={14} />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </Modal>
    </div>
  );
}
