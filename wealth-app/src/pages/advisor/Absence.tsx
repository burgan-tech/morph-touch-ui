import { useEffect, useState, useCallback } from 'react';
import {
  CalendarOff,
  ArrowRight,
  CheckCircle,
  Clock,
  Users,
  AlertTriangle,
  RefreshCw,
} from 'lucide-react';
import {
  startInstance,
  listInstances,
  runTransition,
  getAbsenceEntries,
  getInstance,
} from '../../lib/api';
import { formatDate, formatTime, cn, toUtcIsoFromLocalInput, utcIsoToTransferKeySegment } from '../../lib/utils';
import { STATE_LABELS, DAY_LABELS } from '../../lib/constants';
import { Badge, EmptyState, toast } from '../../components/ui';
import { useAdvisorContext, type AdvisorType } from '../../contexts/AdvisorContext';
import { HISTORY_VISIBILITY_OPTIONS, type MatrixHistoryVisibility } from '../../lib/matrixChat';

/** Workflow slug for rezervation-transfer / API (portfolio-manager | investment-advisor). */
function advisorTypeToFlowSlug(t: AdvisorType | null): string | null {
  if (t === 'PM') return 'portfolio-manager';
  if (t === 'IA') return 'investment-advisor';
  return null;
}

interface VnextInstance {
  key: string;
  id?: string;
  attributes: Record<string, unknown>;
  metadata?: { currentState?: string; createdAt?: string; updatedAt?: string };
}

interface ApiData<T> {
  items?: T[];
  getAbsenceEntry?: { items?: T[] };
  absenceType?: string;
  [key: string]: unknown;
}

function extractAbsenceItems<T>(res: { ok: boolean; data?: unknown }): T[] {
  if (!res.ok || !res.data) return [];
  const d = res.data as ApiData<T>;
  const items = d?.items ?? d?.getAbsenceEntry?.items ?? (d?.data as ApiData<T>)?.items ?? [];
  return Array.isArray(items) ? items : [];
}

function userName(ref: unknown): string {
  if (typeof ref === 'string') return ref;
  if (ref && typeof ref === 'object' && 'key' in ref) return String((ref as { key: string }).key);
  return '—';
}

function advisorKeyMatchesRoomType(key: string, advisorType: string | undefined): boolean {
  const t = (advisorType ?? '').trim().toUpperCase();
  if (t === 'PM') return key.includes('pm');
  if (t === 'IA') return key.includes('ia');
  return true;
}

/** Exclude advisors already in the room (Chat Yönetimi or önceki atamalar) — aligns with ChatManagement. */
function getFilteredAdvisorKeysForRoom(
  baseKeys: string[],
  room: { advisorType?: string; occupiedAdvisorIds?: string[] }
): string[] {
  const occupied = new Set((room.occupiedAdvisorIds ?? []).map((x) => String(x).trim()).filter(Boolean));
  return baseKeys.filter(
    (k) => advisorKeyMatchesRoomType(k, room.advisorType) && !occupied.has(k)
  );
}

export function Absence() {
  const { advisorId, advisorType: ctxAdvisorType } = useAdvisorContext();
  const ADVISOR_ID = advisorId!;
  const [absenceEntries, setAbsenceEntries] = useState<VnextInstance[]>([]);
  const [absenceLoading, setAbsenceLoading] = useState(true);
  const [startDateTime, setStartDateTime] = useState('');
  const [endDateTime, setEndDateTime] = useState('');
  const [annualStep, setAnnualStep] = useState<1 | 2 | 3 | 4>(1);
  const [annualLoading, setAnnualLoading] = useState(false);
  const [selectedRezKeys, setSelectedRezKeys] = useState<Set<string>>(new Set());
  const [selectedRoomKeys, setSelectedRoomKeys] = useState<Set<string>>(new Set());
  /** Matrix user id for add-participant (maps to transferPlan.targetAdvisor in API). */
  const [bulkParticipantMatrixId, setBulkParticipantMatrixId] = useState('');
  const [bulkAssignAdvisor, setBulkAssignAdvisor] = useState('');
  const [termStart, setTermStart] = useState('');
  const [termStep, setTermStep] = useState<1 | 2 | 3 | 4>(1);
  const [termLoading, setTermLoading] = useState(false);
  const [transferInstance, setTransferInstance] = useState<VnextInstance | null>(null);
  const [transferLoading, setTransferLoading] = useState(false);
  const [transferAssignments, setTransferAssignments] = useState<Record<string, string>>({});
  const [permanentAssignments, setPermanentAssignments] = useState<Record<string, string>>({});
  const [permanentRoomHistoryVisibility, setPermanentRoomHistoryVisibility] = useState<
    Record<string, MatrixHistoryVisibility>
  >({});
  const [confirmTransferLoading, setConfirmTransferLoading] = useState(false);
  const [confirmPermanentLoading, setConfirmPermanentLoading] = useState(false);
  const [workingHours, setWorkingHours] = useState<Record<string, { start: string; end: string }[]>>({});
  const [workingHoursLoading, setWorkingHoursLoading] = useState(true);
  const [hasCompletedTermination, setHasCompletedTermination] = useState(false);

  const fetchAbsences = useCallback(async () => {
    setAbsenceLoading(true);
    try {
      const res = await getAbsenceEntries({
        absenceType: 'personal-leave',
        advisor: ADVISOR_ID,
        pageSize: '100',
      });
      const items = extractAbsenceItems<VnextInstance>(res);
      setAbsenceEntries(items);
      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAbsenceLoading(false);
    }
  }, []);

  const allAdvisorKeys = (transferInstance?.attributes?.allAdvisorKeys as string[]) ?? [];
  /** First filled participant Matrix id — used as fallback for other rows (API field: targetAdvisor). */
  const defaultParticipantMatrixId =
    Object.values(transferAssignments).find((v) => v?.trim())?.trim() ?? '';
  /** Fallback for kalıcı oda ataması (gerçek danışman anahtarı). */
  const defaultPermanentAdvisor =
    Object.values(permanentAssignments).find((v) => v?.trim())?.trim() ?? (allAdvisorKeys[0] ?? '');

  const fetchTransferInstance = useCallback(async (instanceId: string) => {
    setTransferLoading(true);
    try {
      const res = await getInstance('rezervation-transfer', instanceId);
      if (res.ok && res.data) {
        const inst = res.data as VnextInstance;
        setTransferInstance(inst);
        const enriched = (inst.attributes?.enrichedRezervations ?? inst.attributes?.enrichedReservations ?? []) as Array<{ key: string }>;
        const initial: Record<string, string> = {};
        enriched.forEach((r) => {
          initial[r.key] = '';
        });
        setTransferAssignments((prev) => ({ ...initial, ...prev }));
        const permRooms = (inst.attributes?.permanentChatRooms ?? []) as Array<{ chatRoomKey?: string; key?: string; instanceKey?: string }>;
        const permInitial: Record<string, string> = {};
        permRooms.forEach((r) => {
          const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '';
          if (k) permInitial[k] = '';
        });
        setPermanentAssignments((prev) => ({ ...permInitial, ...prev }));
        const histInitial: Record<string, MatrixHistoryVisibility> = {};
        permRooms.forEach((r) => {
          const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '';
          if (k) histInitial[k] = 'shared';
        });
        setPermanentRoomHistoryVisibility((prev) => ({ ...histInitial, ...prev }));
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setTransferLoading(false);
    }
  }, []);

  const fetchWorkingHours = useCallback(async () => {
    setWorkingHoursLoading(true);
    try {
      type TimeRange = { start: string; end: string };
      type Schedule = Record<string, TimeRange[]>;
      let found: Schedule | null = null;

      const filter = JSON.stringify({
        and: [{ attributes: { absenceType: { eq: 'working-hours-change' } } }],
      });
      const res = await listInstances('absence-entry', { currentState: 'complete', pageSize: 100, filter });
      if (res.ok && res.data) {
        const d = res.data as ApiData<VnextInstance>;
        const items = d?.items ?? [];
        const list = Array.isArray(items) ? items : [];
        const advisorEntry = list.find((i) => i.key === `working-hour-${ADVISOR_ID}`);
        const companyEntry = list.find((i) => i.key === 'working-hour');
        const entry = advisorEntry ?? companyEntry;
        if (entry?.attributes?.customWorkingHours) {
          found = entry.attributes.customWorkingHours as Schedule;
        }
      }

      setWorkingHours(found ?? {});
    } catch {
      setWorkingHours({});
    } finally {
      setWorkingHoursLoading(false);
    }
  }, [ADVISOR_ID]);

  useEffect(() => {
    fetchAbsences();
  }, [fetchAbsences]);

  useEffect(() => {
    fetchWorkingHours();
  }, [fetchWorkingHours]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await listInstances('rezervation-transfer', { pageSize: 100 });
        if (!res.ok || !res.data || cancelled) return;
        const d = res.data as ApiData<VnextInstance>;
        const items = (d?.items ?? []) as VnextInstance[];
        const completed = items.some(
          (t) =>
            (t.key?.startsWith(`transfer-leave-${ADVISOR_ID}-`) ?? false) &&
            (t.attributes?.transferType as string) === 'termination' &&
            ['completed', 'complete'].includes((t.metadata?.currentState as string) ?? '')
        );
        if (completed && !cancelled) setHasCompletedTermination(true);
      } catch {
        /* ignore */
      }
    })();
    return () => { cancelled = true; };
  }, [ADVISOR_ID]);

  useEffect(() => {
    if (
      transferInstance &&
      (transferInstance.attributes?.transferType as string) === 'termination' &&
      ['completed', 'complete'].includes((transferInstance.metadata?.currentState as string) ?? '')
    ) {
      setHasCompletedTermination(true);
    }
  }, [transferInstance]);

  const handleProceedAnnual = async () => {
    if (!startDateTime) {
      toast('Başlangıç tarihi gerekli', 'error');
      return;
    }
    if (!endDateTime) {
      toast('Bitiş tarihi gerekli', 'error');
      return;
    }

    setAnnualLoading(true);
    try {
      const advisorTypeFlow = advisorTypeToFlowSlug(ctxAdvisorType);
      if (!advisorTypeFlow) {
        toast('Danışman türü (PM veya IA) tanımlı değil. Lütfen tekrar giriş yapın.', 'error');
        return;
      }
      const startUtc = toUtcIsoFromLocalInput(startDateTime);
      const endUtc = toUtcIsoFromLocalInput(endDateTime);
      const safeStart = utcIsoToTransferKeySegment(startUtc);
      const safeEnd = utcIsoToTransferKeySegment(endUtc);
      const key = `personal-leave-${ADVISOR_ID}-${safeStart}-${safeEnd}`;
      const tags = ['personal-leave', 'transfer', 'annual-leave'];

      const attrs: Record<string, unknown> = {
        advisor: ADVISOR_ID,
        advisorType: advisorTypeFlow,
        absenceType: 'personal-leave',
        startDateTime: startUtc,
        endDateTime: endUtc,
        title: 'Yıllık İzin (Transfer Tetikler)',
      };

      const res = await startInstance('absence-entry', { key, tags, attributes: attrs });

      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
        return;
      }

      toast('İzin oluşturuldu, randevu akışı hazırlanıyor...', 'success');
      fetchAbsences();

      const expectedKey = `transfer-leave-${ADVISOR_ID}-${safeStart}`;
      let found: VnextInstance | null = null;

      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const listRes = await listInstances('rezervation-transfer', { pageSize: 20 });
        if (listRes.ok && listRes.data) {
          const listData = listRes.data as ApiData<VnextInstance>;
          const transfers = (listData?.items ?? []) as VnextInstance[];
          found = transfers.find((t) => t.key === expectedKey) ?? transfers[0] ?? null;
          if (found?.metadata?.currentState === 'awaiting-assignment') break;
          const enr = found?.attributes?.enrichedRezervations ?? found?.attributes?.enrichedReservations;
          if (Array.isArray(enr) && enr.length > 0) break;
        }
      }

      if (!found?.id) {
        toast('Randevu akışı bulunamadı. Lütfen sayfayı yenileyin.', 'error');
        return;
      }

      const instRes = await getInstance('rezervation-transfer', found.id);
      if (instRes.ok && instRes.data) {
        const inst = instRes.data as VnextInstance;
        setTransferInstance(inst);
        const enriched = (inst.attributes?.enrichedRezervations ?? inst.attributes?.enrichedReservations ?? []) as Array<{ key: string }>;
        const initial: Record<string, string> = {};
        enriched.forEach((r) => {
          initial[r.key] = '';
        });
        setTransferAssignments(initial);
        const permRooms = (inst.attributes?.permanentChatRooms ?? []) as Array<{
          chatRoomKey?: string;
          key?: string;
          instanceKey?: string;
        }>;
        const permInitial: Record<string, string> = {};
        const histInit: Record<string, MatrixHistoryVisibility> = {};
        permRooms.forEach((r) => {
          const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '';
          if (k) {
            permInitial[k] = '';
            histInit[k] = 'shared';
          }
        });
        setPermanentAssignments(permInitial);
        setPermanentRoomHistoryVisibility(histInit);
        setSelectedRezKeys(new Set());
        setSelectedRoomKeys(new Set());
        setBulkParticipantMatrixId('');
        setBulkAssignAdvisor('');
        setAnnualStep(2);
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setAnnualLoading(false);
    }
  };

  const handleCreateTermination = async () => {
    if (!termStart) {
      toast('Başlangıç tarihi gerekli', 'error');
      return;
    }

    setTermLoading(true);
    try {
      const advisorTypeFlow = advisorTypeToFlowSlug(ctxAdvisorType);
      if (!advisorTypeFlow) {
        toast('Danışman türü (PM veya IA) tanımlı değil. Lütfen tekrar giriş yapın.', 'error');
        return;
      }
      const termStartUtc = toUtcIsoFromLocalInput(termStart);
      const safeStart = utcIsoToTransferKeySegment(termStartUtc);
      const key = `personal-leave-${ADVISOR_ID}-${safeStart}`;
      const tags = ['personal-leave', 'transfer', 'termination'];

      const attrs: Record<string, unknown> = {
        advisor: ADVISOR_ID,
        advisorType: advisorTypeFlow,
        absenceType: 'personal-leave',
        startDateTime: termStartUtc,
        title: 'İstifa / Ayrılış (Termination Transfer Tetikler)',
      };

      const res = await startInstance('absence-entry', { key, tags, attributes: attrs });

      if (!res.ok) {
        const err = (res.data as Record<string, unknown>)?.error;
        toast(String(err ?? `Hata: ${res.status}`), 'error');
        return;
      }

      toast('İşten çıkış kaydı oluşturuldu, randevu akışı hazırlanıyor...', 'success');
      fetchAbsences();

      const expectedKey = `transfer-leave-${ADVISOR_ID}-${safeStart}`;
      let found: VnextInstance | null = null;

      for (let i = 0; i < 10; i++) {
        await new Promise((r) => setTimeout(r, 1500));
        const listRes = await listInstances('rezervation-transfer', { pageSize: 20 });
        if (listRes.ok && listRes.data) {
          const listData = listRes.data as ApiData<VnextInstance>;
          const transfers = (listData?.items ?? []) as VnextInstance[];
          found = transfers.find((t) => t.key === expectedKey) ?? transfers[0] ?? null;
          if (found?.metadata?.currentState === 'awaiting-assignment') break;
          const enr = found?.attributes?.enrichedRezervations ?? found?.attributes?.enrichedReservations;
          if (Array.isArray(enr) && enr.length > 0) break;
        }
      }

      if (!found?.id) {
        toast('Randevu akışı bulunamadı. Lütfen sayfayı yenileyin.', 'error');
        return;
      }

      const instRes = await getInstance('rezervation-transfer', found.id);
      if (instRes.ok && instRes.data) {
        const inst = instRes.data as VnextInstance;
        setTransferInstance(inst);
        const enriched = (inst.attributes?.enrichedRezervations ?? inst.attributes?.enrichedReservations ?? []) as Array<{ key: string }>;
        const initial: Record<string, string> = {};
        enriched.forEach((r) => {
          initial[r.key] = '';
        });
        setTransferAssignments(initial);
        const permRooms = (inst.attributes?.permanentChatRooms ?? []) as Array<{
          chatRoomKey?: string;
          key?: string;
          instanceKey?: string;
        }>;
        const permInitial: Record<string, string> = {};
        const histInit: Record<string, MatrixHistoryVisibility> = {};
        permRooms.forEach((r) => {
          const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '';
          if (k) {
            permInitial[k] = '';
            histInit[k] = 'shared';
          }
        });
        setPermanentAssignments(permInitial);
        setPermanentRoomHistoryVisibility(histInit);
        setSelectedRezKeys(new Set());
        setSelectedRoomKeys(new Set());
        setBulkParticipantMatrixId('');
        setBulkAssignAdvisor('');
        setTermStep(2);
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setTermLoading(false);
    }
  };

  const handleConfirmTransfer = async () => {
    if (!transferInstance?.id) return;
    const fallbackParticipant = defaultParticipantMatrixId;
    const enriched = (transferInstance.attributes?.enrichedRezervations ?? transferInstance.attributes?.enrichedReservations ?? []) as Array<{ key: string }>;
    const plan = enriched
      .map((r) => ({
        rezervationKey: r.key,
        targetAdvisor: transferAssignments[r.key]?.trim() || fallbackParticipant.trim(),
      }))
      .filter((p) => p.targetAdvisor);
    if (plan.length === 0) {
      toast('En az bir randevu için davetli Matrix kullanıcı kimliği girin', 'error');
      return;
    }
    setConfirmTransferLoading(true);
    try {
      const res = await runTransition(
        'rezervation-transfer',
        transferInstance.id,
        'confirm-transfer',
        { attributes: { transferPlan: plan } }
      );
      if (res.ok) {
        toast('Katılımcı davetleri onaylandı; ardından kalıcı oda ataması yapılacak.', 'success');
        await fetchTransferInstance(transferInstance.id);
        if ((transferInstance.attributes?.transferType as string) === 'annual-leave') setAnnualStep(4);
        if ((transferInstance.attributes?.transferType as string) === 'termination') setTermStep(4);
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setConfirmTransferLoading(false);
    }
  };

  const handleConfirmPermanentRooms = async () => {
    if (!transferInstance?.id) return;
    const st = transferInstance.metadata?.currentState ?? '';
    if (st !== 'awaiting-permanent-assignment') {
      toast(
        st === 'updating-permanent-chatrooms'
          ? 'Kalıcı odalar arka planda işleniyor; lütfen yenileyin veya tamamlanmasını bekleyin.'
          : 'Bu adım yalnızca kalıcı oda ataması beklenirken kullanılabilir.',
        'info'
      );
      return;
    }
    const fallbackTarget = defaultPermanentAdvisor;
    const permRooms = (transferInstance.attributes?.permanentChatRooms ?? []) as Array<{ chatRoomKey?: string; key?: string; instanceKey?: string }>;
    const plan = permRooms
      .map((r) => {
        const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '';
        return {
          chatRoomKey: k,
          targetAdvisor: permanentAssignments[k]?.trim() || fallbackTarget.trim(),
          historyVisibility: permanentRoomHistoryVisibility[k] ?? 'shared',
        };
      })
      .filter((p) => p.chatRoomKey && p.targetAdvisor);
    if (plan.length === 0 && permRooms.length > 0) {
      toast('Kalıcı oda ataması gerekli', 'error');
      return;
    }
    setConfirmPermanentLoading(true);
    try {
      const res = await runTransition(
        'rezervation-transfer',
        transferInstance.id,
        'confirm-permanent-rooms',
        { attributes: { permanentRoomPlan: plan } }
      );
      if (res.ok) {
        toast('Kalıcı odalar onaylandı', 'success');
        await fetchTransferInstance(transferInstance.id);
      } else {
        toast(String((res.data as Record<string, unknown>)?.error ?? `Hata: ${res.status}`), 'error');
      }
    } catch (e) {
      toast(String(e), 'error');
    } finally {
      setConfirmPermanentLoading(false);
    }
  };

  const state = transferInstance?.metadata?.currentState ?? '';
  const enriched = (transferInstance?.attributes?.enrichedRezervations ?? transferInstance?.attributes?.enrichedReservations ?? []) as Array<{
    key: string;
    startDateTime?: string;
    endDateTime?: string;
    user?: unknown;
    availableAdvisors?: string[];
  }>;
  const permRooms = (transferInstance?.attributes?.permanentChatRooms ?? []) as Array<{
    chatRoomKey?: string;
    key?: string;
    instanceKey?: string;
    user?: unknown;
    advisorType?: string;
    occupiedAdvisorIds?: string[];
  }>;
  const transferType = (transferInstance?.attributes?.transferType as string) ?? '';

  const fromAllAdvisorAttrs = (transferInstance?.attributes?.allAdvisorKeys as string[]) ?? [];
  const baseAdvisorKeysList =
    fromAllAdvisorAttrs.length > 0
      ? fromAllAdvisorAttrs
      : [...new Set(enriched.flatMap((r) => r.availableAdvisors ?? []))];

  const currentStep =
    state === 'awaiting-assignment'
      ? 2
      : state === 'validating' ||
          state === 'awaiting-permanent-assignment' ||
          state === 'updating-permanent-chatrooms'
        ? 3
        : state === 'completed' || state === 'complete'
          ? 4
          : 1;

  const showTransferFlow = !!transferInstance;

  const isWizardFlow = (transferType === 'annual-leave' && annualStep >= 2) || (transferType === 'termination' && termStep >= 2);
  const wizardStep = transferType === 'termination' ? termStep : annualStep;
  const setWizardStep = transferType === 'termination' ? setTermStep : setAnnualStep;

  return (
    <div className="page">
      <div className="page-header">
        <h1>İzin & Çalışma Durumum</h1>
      </div>

      <div className="page-grid">
        {/* Section 1: İzin Listesi (Annual Leave form + liste) */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <div className="flex items-center gap-2">
              <CalendarOff size={20} />
              <h3>İzin Listesi</h3>
            </div>
            <button
              className="btn btn-secondary btn-sm"
              onClick={fetchAbsences}
              disabled={absenceLoading}
              title="Yenile"
            >
              <RefreshCw size={16} className={absenceLoading ? 'animate-spin' : ''} />
              Yenile
            </button>
          </div>
          <div className="card-body">
            {/* Adım 1: Sadece Tarih Girişi */}
            <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
              <div className="form-group">
                <label className="form-label">Başlangıç Tarihi</label>
                <input
                  type="datetime-local"
                  className="form-input"
                  value={startDateTime}
                  onChange={(e) => setStartDateTime(e.target.value)}
                  disabled={annualStep > 1}
                />
              </div>
              <div className="form-group">
                <label className="form-label">Bitiş Tarihi</label>
                <input
                  type="datetime-local"
                  className="form-input"
                  value={endDateTime}
                  onChange={(e) => setEndDateTime(e.target.value)}
                  disabled={annualStep > 1}
                />
              </div>
            </div>
            {annualStep === 1 && (
              <button
                className="btn btn-primary mt-4"
                onClick={handleProceedAnnual}
                disabled={annualLoading}
              >
                {annualLoading ? (
                  <>
                    <RefreshCw size={16} className="animate-spin" />
                    Hazırlanıyor...
                  </>
                ) : (
                  <>
                    <ArrowRight size={16} />
                    İlerle
                  </>
                )}
              </button>
            )}

            <hr className="my-6" style={{ borderColor: 'var(--color-border)' }} />

            {absenceLoading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Yükleniyor...</p>
              </div>
            ) : absenceEntries.length === 0 ? (
              <EmptyState message="İzin kaydı yok" icon={<CalendarOff size={40} strokeWidth={1.5} />} />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Tarih</th>
                      <th>Tür</th>
                      <th>Durum</th>
                    </tr>
                  </thead>
                  <tbody>
                    {absenceEntries.map((it) => {
                      const attr = it.attributes ?? {};
                      const st = it.metadata?.currentState ?? '?';
                      return (
                        <tr key={it.key}>
                          <td>
                            {formatDate(attr.startDateTime as string)}
                            {attr.endDateTime ? ` – ${formatDate(attr.endDateTime as string)}` : null}
                          </td>
                          <td>{String(attr.title ?? attr.absenceType ?? '—')}</td>
                          <td>
                            <Badge state={st} />
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>

        {/* Section 2: Transfer Akışı */}
        {showTransferFlow && (
          <div className="card" style={{ gridColumn: '1 / -1' }}>
            <div className="card-header">
              <div className="flex items-center gap-2">
                <ArrowRight size={20} />
                <h3>Randevu katılımcı akışı</h3>
                {transferType && (
                  <span className="text-muted text-sm">({transferType})</span>
                )}
              </div>
              {transferInstance?.id && (
                <button
                  className="btn btn-secondary btn-sm"
                  onClick={() => fetchTransferInstance(transferInstance.id!)}
                  disabled={transferLoading}
                >
                  <RefreshCw size={14} className={transferLoading ? 'animate-spin' : ''} />
                  Yenile
                </button>
              )}
            </div>
            <div className="card-body">
              {isWizardFlow ? (
                /* Annual Leave / Termination Wizard */
                <>
                  <div className="steps">
                    <div className={cn('step', wizardStep >= 1 && 'done', wizardStep === 1 && 'active')}>
                      <span className="step-num">1</span>
                      <span>Tarih</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', wizardStep >= 2 && 'done', wizardStep === 2 && 'active')}>
                      <span className="step-num">2</span>
                      <span>Randevu Bilgisi</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', wizardStep >= 3 && 'done', wizardStep === 3 && 'active')}>
                      <span className="step-num">3</span>
                      <span>Katılımcı (Matrix)</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', wizardStep >= 4 && 'done', wizardStep === 4 && 'active')}>
                      <span className="step-num">4</span>
                      <span>Kalıcı oda</span>
                    </div>
                  </div>

                  {transferLoading ? (
                    <div className="empty-state">
                      <RefreshCw size={32} className="animate-spin" />
                      <p>Akış bilgisi yükleniyor...</p>
                    </div>
                  ) : wizardStep === 2 ? (
                    /* Adım 2: Rezervasyon Bilgisi */
                    <>
                      <h4 className="flex items-center gap-2 mt-4" style={{ marginBottom: 12 }}>
                        <Users size={18} />
                        {transferType === 'termination' ? 'Randevularınız (başlangıç tarihinden itibaren tümü)' : 'Tarih aralığındaki randevularınız'}
                      </h4>
                      {enriched.length === 0 ? (
                        <EmptyState message="Bu tarih aralığında randevu yok" />
                      ) : (
                        <>
                          <div className="table-wrapper">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>Tarih / Saat</th>
                                  <th>Müşteri</th>
                                  <th>Referans: müsait danışmanlar</th>
                                </tr>
                              </thead>
                              <tbody>
                                {enriched.map((r) => (
                                  <tr key={r.key}>
                                    <td>
                                      {formatDate(r.startDateTime)} {formatTime(r.startDateTime)} – {formatTime(r.endDateTime)}
                                    </td>
                                    <td>{userName(r.user)}</td>
                                    <td>
                                      <span className="text-muted text-sm">
                                        {(r.availableAdvisors ?? []).join(', ') || '—'}
                                      </span>
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button className="btn btn-primary mt-4" onClick={() => setWizardStep(3)}>
                            Sonraki Adım
                          </button>
                        </>
                      )}
                    </>
                  ) : wizardStep === 3 ? (
                    /* Adım 3: Randevu Atama */
                    <>
                      <h4 className="flex items-center gap-2 mt-4" style={{ marginBottom: 12 }}>
                        <Users size={18} />
                        Randevuya davetli kullanıcı (Matrix ID)
                      </h4>
                      <p className="text-muted text-sm mb-4" style={{ marginTop: -4 }}>
                        Her randevu için o randevuya davet edilecek kişinin Matrix kullanıcı kimliğini girin (ör. <span className="font-mono">morph-touch.portfolio-manager.pm-002</span>).
                      </p>
                      {enriched.length === 0 ? (
                        <EmptyState message="İşlem yapılacak randevu yok" />
                      ) : (
                        <>
                          <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap', alignItems: 'center' }}>
                            <input
                              type="text"
                              className="form-input"
                              placeholder="Davetli Matrix kullanıcı kimliği"
                              value={bulkParticipantMatrixId}
                              onChange={(e) => setBulkParticipantMatrixId(e.target.value)}
                              style={{ minWidth: 220 }}
                            />
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                const v = bulkParticipantMatrixId.trim();
                                if (!v) return;
                                setTransferAssignments((prev) => {
                                  const next = { ...prev };
                                  selectedRezKeys.forEach((k) => { next[k] = v; });
                                  return next;
                                });
                              }}
                              disabled={selectedRezKeys.size === 0 || !bulkParticipantMatrixId.trim()}
                            >
                              Seçilen satırlara uygula
                            </button>
                            <button
                              className="btn btn-secondary btn-sm"
                              onClick={() => {
                                const unassigned = enriched.filter((r) => !transferAssignments[r.key]?.trim()).map((r) => r.key);
                                setSelectedRezKeys(new Set(unassigned));
                              }}
                            >
                              Atanmamışları seç
                            </button>
                          </div>
                          <div className="table-wrapper">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th style={{ width: 40 }}>
                                    <input
                                      type="checkbox"
                                      checked={enriched.length > 0 && enriched.every((r) => selectedRezKeys.has(r.key))}
                                      onChange={(e) => {
                                        if (e.target.checked) setSelectedRezKeys(new Set(enriched.map((r) => r.key)));
                                        else setSelectedRezKeys(new Set());
                                      }}
                                    />
                                  </th>
                                  <th>Tarih</th>
                                  <th>Müşteri</th>
                                  <th>Referans: müsait danışmanlar</th>
                                  <th>Davetli kullanıcı (Matrix ID)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {enriched.map((r) => (
                                  <tr key={r.key}>
                                    <td>
                                      <input
                                        type="checkbox"
                                        checked={selectedRezKeys.has(r.key)}
                                        onChange={(e) => {
                                          if (e.target.checked) setSelectedRezKeys((prev) => new Set([...prev, r.key]));
                                          else setSelectedRezKeys((prev) => { const n = new Set(prev); n.delete(r.key); return n; });
                                        }}
                                      />
                                    </td>
                                    <td>{formatDate(r.startDateTime)} {formatTime(r.startDateTime)}</td>
                                    <td>{userName(r.user)}</td>
                                    <td>
                                      <span className="text-muted text-sm">{(r.availableAdvisors ?? []).join(', ') || '—'}</span>
                                    </td>
                                    <td>
                                      <input
                                        type="text"
                                        className="form-input font-mono text-sm"
                                        placeholder="morph-touch.portfolio-manager.pm-002"
                                        value={transferAssignments[r.key] ?? ''}
                                        onChange={(e) =>
                                          setTransferAssignments((prev) => ({ ...prev, [r.key]: e.target.value }))
                                        }
                                        style={{ minWidth: 200 }}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button
                            className="btn btn-success mt-4"
                            onClick={handleConfirmTransfer}
                            disabled={confirmTransferLoading}
                          >
                            {confirmTransferLoading ? (
                              <>
                                <RefreshCw size={16} className="animate-spin" />
                                Onaylanıyor...
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} />
                                Katılımcı davetlerini onayla
                              </>
                            )}
                          </button>
                        </>
                      )}
                    </>
                  ) : wizardStep === 4 &&
                    (state === 'validating' ||
                      state === 'awaiting-permanent-assignment' ||
                      state === 'updating-permanent-chatrooms' ||
                      state === 'completed' ||
                      state === 'complete') ? (
                    /* Adım 4: Kalıcı oda ataması */
                    state === 'validating' ? (
                      <div className="empty-state" style={{ padding: 24 }}>
                        <RefreshCw size={48} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                        <p className="font-medium mt-4">Katılımcı davetleri işleniyor</p>
                        <p className="text-muted text-sm">
                          Randevulara davetler tamamlanınca kalıcı sohbet odası atama ekranı açılır. Birkaç saniye sonra yenileyin.
                        </p>
                        {transferInstance?.id ? (
                          <button
                            type="button"
                            className="btn btn-secondary mt-4"
                            onClick={() => fetchTransferInstance(transferInstance.id!)}
                            disabled={transferLoading}
                          >
                            <RefreshCw size={16} className={transferLoading ? 'animate-spin' : ''} />
                            Durumu yenile
                          </button>
                        ) : null}
                      </div>
                    ) : state === 'completed' || state === 'complete' ? (
                      <div className="empty-state" style={{ padding: 24 }}>
                        <CheckCircle size={48} style={{ color: 'var(--color-success)' }} />
                        <p className="font-medium">İşlem tamamlandı</p>
                        <p className="text-muted text-sm">
                          {transferType === 'termination'
                            ? 'Randevu katılımcıları ve kalıcı sohbet odaları işlendi. İşten çıkış süreci bittiyse bu bölüm artık kullanılamaz.'
                            : 'Randevu katılımcıları eklendi ve kalıcı odalar atandı.'}
                        </p>
                        {transferType === 'termination' ? (
                          <button className="btn btn-secondary mt-4" onClick={() => setTransferInstance(null)}>
                            Kapat
                          </button>
                        ) : (
                          <button className="btn btn-secondary mt-4" onClick={() => {
                            setAnnualStep(1);
                            setStartDateTime('');
                            setEndDateTime('');
                            setTransferInstance(null);
                          }}>
                            Yeni İzin Girişi
                          </button>
                        )}
                      </div>
                    ) : state === 'updating-permanent-chatrooms' ? (
                      <div className="empty-state" style={{ padding: 24 }}>
                        <RefreshCw size={48} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                        <p className="font-medium mt-4">Kalıcı odalar işleniyor</p>
                        <p className="text-muted text-sm">
                          Arka planda her oda sırayla güncelleniyor. Tamamlanınca bu ekran &quot;Transfer tamamlandı&quot; olarak güncellenir.
                        </p>
                        {transferInstance?.id ? (
                          <button
                            type="button"
                            className="btn btn-secondary mt-4"
                            onClick={() => fetchTransferInstance(transferInstance.id!)}
                            disabled={transferLoading}
                          >
                            <RefreshCw size={16} className={transferLoading ? 'animate-spin' : ''} />
                            Durumu yenile
                          </button>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        <h4 className="flex items-center gap-2 mt-4" style={{ marginBottom: 12 }}>
                          <Users size={18} />
                          Kalıcı sohbet odası ataması
                        </h4>
                        <p className="text-muted text-sm mb-4" style={{ marginTop: -4 }}>
                          Randevu katılımcıları eklendikten sonra müşteri kalıcı odalarında yeni danışman ve mesaj geçmişi seçeneklerini belirleyin.
                        </p>
                        {permRooms.length === 0 ? (
                          <>
                            <p className="text-muted text-sm">Bu danışman için atanacak kalıcı oda bulunamadı; devam edebilirsiniz.</p>
                            <button
                              className="btn btn-success mt-4"
                              onClick={handleConfirmPermanentRooms}
                              disabled={confirmPermanentLoading}
                            >
                              {confirmPermanentLoading ? (
                                <>
                                  <RefreshCw size={16} className="animate-spin" />
                                  Onaylanıyor...
                                </>
                              ) : (
                                <>
                                  <CheckCircle size={16} />
                                  Devam Et
                                </>
                              )}
                            </button>
                          </>
                        ) : (
                          <>
                            <div className="flex gap-2 mb-4" style={{ flexWrap: 'wrap' }}>
                              <select
                                className="form-input"
                                value={bulkAssignAdvisor}
                                onChange={(e) => setBulkAssignAdvisor(e.target.value)}
                                style={{ minWidth: 180 }}
                              >
                                <option value="">— Seçilenleri ata —</option>
                                {baseAdvisorKeysList.map((adv) => (
                                  <option key={adv} value={adv}>{adv}</option>
                                ))}
                              </select>
                              <button
                                className="btn btn-secondary btn-sm"
                                onClick={() => {
                                  if (!bulkAssignAdvisor) return;
                                  setPermanentAssignments((prev) => {
                                    const next = { ...prev };
                                    selectedRoomKeys.forEach((k) => { next[k] = bulkAssignAdvisor; });
                                    return next;
                                  });
                                }}
                                disabled={selectedRoomKeys.size === 0 || !bulkAssignAdvisor}
                              >
                                Seçilenleri ata
                              </button>
                            </div>
                            <div className="table-wrapper">
                              <table className="table">
                                <thead>
                                  <tr>
                                    <th style={{ width: 40 }}>
                                      <input
                                        type="checkbox"
                                        checked={permRooms.length > 0 && permRooms.every((r) => selectedRoomKeys.has(r.chatRoomKey ?? r.key ?? r.instanceKey ?? ''))}
                                        onChange={(e) => {
                                          if (e.target.checked) setSelectedRoomKeys(new Set(permRooms.map((r) => r.chatRoomKey ?? r.key ?? r.instanceKey ?? '').filter(Boolean)));
                                          else setSelectedRoomKeys(new Set());
                                        }}
                                      />
                                    </th>
                                    <th>Oda</th>
                                    <th>Müşteri</th>
                                    <th>Hedef Danışman</th>
                                    <th>Mesaj geçmişi (yeni üye)</th>
                                  </tr>
                                </thead>
                                <tbody>
                                  {permRooms.map((r) => {
                                    const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '?';
                                    const advisorOptions = getFilteredAdvisorKeysForRoom(baseAdvisorKeysList, r);
                                    return (
                                      <tr key={k}>
                                        <td>
                                          <input
                                            type="checkbox"
                                            checked={selectedRoomKeys.has(k)}
                                            onChange={(e) => {
                                              if (e.target.checked) setSelectedRoomKeys((prev) => new Set([...prev, k]));
                                              else setSelectedRoomKeys((prev) => { const n = new Set(prev); n.delete(k); return n; });
                                            }}
                                          />
                                        </td>
                                        <td className="font-mono text-sm">{k}</td>
                                        <td>{userName(r.user)}</td>
                                        <td>
                                          <select
                                            className="form-input"
                                            value={permanentAssignments[k] ?? ''}
                                            onChange={(e) =>
                                              setPermanentAssignments((prev) => ({ ...prev, [k]: e.target.value }))
                                            }
                                            style={{ minWidth: 160 }}
                                          >
                                            <option value="">— Seçin —</option>
                                            {advisorOptions.map((adv) => (
                                              <option key={adv} value={adv}>{adv}</option>
                                            ))}
                                          </select>
                                        </td>
                                        <td>
                                          <select
                                            className="form-input"
                                            value={permanentRoomHistoryVisibility[k] ?? 'shared'}
                                            onChange={(e) =>
                                              setPermanentRoomHistoryVisibility((prev) => ({
                                                ...prev,
                                                [k]: e.target.value as MatrixHistoryVisibility,
                                              }))
                                            }
                                            style={{ minWidth: 140 }}
                                            title="Matrix: yeni üye davet edilmeden önce"
                                          >
                                            {HISTORY_VISIBILITY_OPTIONS.map((o) => (
                                              <option key={o.value} value={o.value}>
                                                {o.label}
                                              </option>
                                            ))}
                                          </select>
                                        </td>
                                      </tr>
                                    );
                                  })}
                                </tbody>
                              </table>
                            </div>
                            <button
                              className="btn btn-success mt-4"
                              onClick={handleConfirmPermanentRooms}
                              disabled={confirmPermanentLoading}
                            >
                              {confirmPermanentLoading ? (
                                <>
                                  <RefreshCw size={16} className="animate-spin" />
                                  Onaylanıyor...
                                </>
                              ) : (
                                <>
                                  <CheckCircle size={16} />
                                  Kalıcı Odaları Onayla
                                </>
                              )}
                            </button>
                          </>
                        )}
                      </>
                    )
                  ) : null}
                </>
              ) : (
                /* Termination or fallback: state-based UI */
                <>
                  <div className="steps">
                    <div className={cn('step', currentStep >= 1 && 'done', currentStep === 1 && 'active')}>
                      <span className="step-num">1</span>
                      <span>İzin Girişi</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', currentStep >= 2 && 'done', currentStep === 2 && 'active')}>
                      <span className="step-num">2</span>
                      <span>Randevu katılımcısı</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', currentStep >= 3 && 'done', currentStep === 3 && 'active')}>
                      <span className="step-num">3</span>
                      <span>Kalıcı Odalar</span>
                    </div>
                    <div className="step-divider" />
                    <div className={cn('step', (currentStep >= 4) && 'done', currentStep === 4 && 'active')}>
                      <span className="step-num">4</span>
                      <span>Tamamlandı</span>
                    </div>
                  </div>

                  {transferLoading ? (
                    <div className="empty-state">
                      <RefreshCw size={32} className="animate-spin" />
                      <p>Akış bilgisi yükleniyor...</p>
                    </div>
                  ) : state === 'validating' ? (
                    <div className="empty-state" style={{ padding: 24 }}>
                      <RefreshCw size={48} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                      <p className="font-medium mt-4">Katılımcı davetleri işleniyor</p>
                      <p className="text-muted text-sm">
                        Tamamlanınca kalıcı oda ataması ekranına geçilir. Gerekirse yenileyin.
                      </p>
                      {transferInstance?.id ? (
                        <button
                          type="button"
                          className="btn btn-secondary mt-4"
                          onClick={() => fetchTransferInstance(transferInstance.id!)}
                          disabled={transferLoading}
                        >
                          <RefreshCw size={16} className={transferLoading ? 'animate-spin' : ''} />
                          Durumu yenile
                        </button>
                      ) : null}
                    </div>
                  ) : state === 'awaiting-assignment' ? (
                    <>
                      <h4 className="flex items-center gap-2 mt-4" style={{ marginBottom: 12 }}>
                        <Users size={18} />
                        Randevu listesi — davetli Matrix kullanıcısı
                      </h4>
                      <p className="text-muted text-sm mb-3">
                        Her satır için randevuya eklenecek Matrix kullanıcı kimliğini girin.
                      </p>
                      {enriched.length === 0 ? (
                        <EmptyState message="İşlem yapılacak randevu yok" />
                      ) : (
                        <>
                          <div className="table-wrapper">
                            <table className="table">
                              <thead>
                                <tr>
                                  <th>Saat</th>
                                  <th>Müşteri</th>
                                  <th>Durum</th>
                                  <th>Davetli (Matrix ID)</th>
                                </tr>
                              </thead>
                              <tbody>
                                {enriched.map((r) => (
                                  <tr key={r.key}>
                                    <td>
                                      {formatTime(r.startDateTime)} – {formatTime(r.endDateTime)}
                                    </td>
                                    <td>{userName(r.user)}</td>
                                    <td>
                                      <Badge state={String((r as Record<string, unknown>).currentState ?? 'active')} />
                                    </td>
                                    <td>
                                      <input
                                        type="text"
                                        className="form-input font-mono text-sm"
                                        placeholder="morph-touch.portfolio-manager.pm-002"
                                        value={transferAssignments[r.key] ?? ''}
                                        onChange={(e) =>
                                          setTransferAssignments((prev) => ({
                                            ...prev,
                                            [r.key]: e.target.value,
                                          }))
                                        }
                                        style={{ minWidth: 200 }}
                                      />
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                          <button
                            className="btn btn-success mt-4"
                            onClick={handleConfirmTransfer}
                            disabled={confirmTransferLoading}
                          >
                            {confirmTransferLoading ? (
                              <>
                                <RefreshCw size={16} className="animate-spin" />
                                Onaylanıyor...
                              </>
                            ) : (
                              <>
                                <CheckCircle size={16} />
                                Katılımcı davetlerini onayla
                              </>
                            )}
                          </button>
                        </>
                      )}
                    </>
                  ) : state === 'updating-permanent-chatrooms' ? (
                <div className="empty-state" style={{ padding: 24 }}>
                  <RefreshCw size={48} className="animate-spin" style={{ color: 'var(--color-primary)' }} />
                  <p className="font-medium mt-4">Kalıcı odalar işleniyor</p>
                  <p className="text-muted text-sm">
                    Arka planda her oda sırayla güncelleniyor. Tamamlanınca durum &quot;Tamamlandı&quot; olur.
                  </p>
                  {transferInstance?.id ? (
                    <button
                      type="button"
                      className="btn btn-secondary mt-4"
                      onClick={() => fetchTransferInstance(transferInstance.id!)}
                      disabled={transferLoading}
                    >
                      <RefreshCw size={16} className={transferLoading ? 'animate-spin' : ''} />
                      Durumu yenile
                    </button>
                  ) : null}
                </div>
              ) : state === 'awaiting-permanent-assignment' ? (
                <>
                  <h4 className="flex items-center gap-2 mt-4" style={{ marginBottom: 12 }}>
                    <Users size={18} />
                    Kalıcı sohbet odası ataması
                  </h4>
                  <p className="text-muted text-sm mb-3">
                    Randevu katılımcıları işlendikten sonra kalıcı odalarda hedef danışmanı ve yeni üye için mesaj geçmişini seçin.
                  </p>
                  {permRooms.length === 0 ? (
                    <>
                      <p className="text-muted text-sm">Kalıcı oda yok; devam edebilirsiniz.</p>
                      <button
                        className="btn btn-success mt-4"
                        onClick={handleConfirmPermanentRooms}
                        disabled={confirmPermanentLoading}
                      >
                        {confirmPermanentLoading ? (
                          <>
                            <RefreshCw size={16} className="animate-spin" />
                            Onaylanıyor...
                          </>
                        ) : (
                          <>
                            <CheckCircle size={16} />
                            Devam Et
                          </>
                        )}
                      </button>
                    </>
                  ) : (
                    <>
                      <div className="table-wrapper">
                        <table className="table">
                          <thead>
                            <tr>
                              <th>Oda</th>
                              <th>Müşteri</th>
                              <th>Hedef Danışman</th>
                              <th>Mesaj geçmişi (yeni üye)</th>
                            </tr>
                          </thead>
                          <tbody>
                            {permRooms.map((r) => {
                              const k = r.chatRoomKey ?? r.key ?? r.instanceKey ?? '?';
                              const advisorOptions = getFilteredAdvisorKeysForRoom(baseAdvisorKeysList, r);
                              return (
                                <tr key={k}>
                                  <td className="font-mono text-sm">{k}</td>
                                  <td>{userName(r.user)}</td>
                                  <td>
                                    <select
                                      className="form-input"
                                      value={permanentAssignments[k] ?? ''}
                                      onChange={(e) =>
                                        setPermanentAssignments((prev) => ({
                                          ...prev,
                                          [k]: e.target.value,
                                        }))
                                      }
                                      style={{ minWidth: 160 }}
                                    >
                                      <option value="">— Seçin —</option>
                                      {advisorOptions.map((adv) => (
                                        <option key={adv} value={adv}>{adv}</option>
                                      ))}
                                    </select>
                                  </td>
                                  <td>
                                    <select
                                      className="form-input"
                                      value={permanentRoomHistoryVisibility[k] ?? 'shared'}
                                      onChange={(e) =>
                                        setPermanentRoomHistoryVisibility((prev) => ({
                                          ...prev,
                                          [k]: e.target.value as MatrixHistoryVisibility,
                                        }))
                                      }
                                      style={{ minWidth: 140 }}
                                      title="Matrix: yeni üye davet edilmeden önce"
                                    >
                                      {HISTORY_VISIBILITY_OPTIONS.map((o) => (
                                        <option key={o.value} value={o.value}>
                                          {o.label}
                                        </option>
                                      ))}
                                    </select>
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                      <button
                        className="btn btn-success mt-4"
                        onClick={handleConfirmPermanentRooms}
                        disabled={confirmPermanentLoading}
                      >
                        {confirmPermanentLoading ? (
                          <>
                            <RefreshCw size={16} className="animate-spin" />
                            Onaylanıyor...
                          </>
                        ) : (
                          <>
                            <CheckCircle size={16} />
                            Kalıcı Odaları Onayla
                          </>
                        )}
                      </button>
                    </>
                  )}
                </>
              ) : state === 'completed' || state === 'complete' ? (
                <div className="empty-state" style={{ padding: 24 }}>
                  <CheckCircle size={48} style={{ color: 'var(--color-success)' }} />
                  <p className="font-medium">İşlem tamamlandı</p>
                  <p className="text-muted text-sm">
                    Randevu katılımcıları ve kalıcı sohbet odaları bu akış üzerinden tamamlandı.
                  </p>
                </div>
              ) : (
                <div className="flex items-center gap-2 p-3" style={{ background: 'var(--color-bg)', borderRadius: 'var(--radius)' }}>
                  <AlertTriangle size={20} className="text-muted" />
                  <span className="text-muted text-sm">
                    Akış işleniyor veya bekleniyor. Durum: {STATE_LABELS[state] ?? state}
                  </span>
                </div>
              )}
                </>
              )}
            </div>
          </div>
        )}

        {/* Section 3: İşten Çıkış Süreci (Termination) - gizli: tamamlanmış işten çıkış */}
        {!hasCompletedTermination && (
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <div className="flex items-center gap-2">
              <AlertTriangle size={20} />
              <h3>İşten Çıkış Süreci</h3>
            </div>
          </div>
          <div className="card-body">
            {termStep === 1 ? (
              <>
                <div className="form-row" style={{ flexWrap: 'wrap', gap: 16 }}>
                  <div className="form-group">
                    <label className="form-label">Başlangıç Tarihi</label>
                    <input
                      type="datetime-local"
                      className="form-input"
                      value={termStart}
                      onChange={(e) => setTermStart(e.target.value)}
                      disabled={termStep > 1}
                    />
                  </div>
                </div>
                <button
                  className="btn btn-primary mt-4"
                  onClick={handleCreateTermination}
                  disabled={termLoading}
                >
                  {termLoading ? (
                    <>
                      <RefreshCw size={16} className="animate-spin" />
                      Hazırlanıyor...
                    </>
                  ) : (
                    <>
                      <ArrowRight size={16} />
                      İlerle
                    </>
                  )}
                </button>
              </>
            ) : (
              <p className="text-muted text-sm">Randevu katılımcı akışında devam edin (yukarıdaki bölüme bakın).</p>
            )}
          </div>
        </div>
        )}

        {/* Section 4: Çalışma Saatleri */}
        <div className="card" style={{ gridColumn: '1 / -1' }}>
          <div className="card-header">
            <div className="flex items-center gap-2">
              <Clock size={20} />
              <h3>Çalışma Saatleri</h3>
            </div>
          </div>
          <div className="card-body">
            {workingHoursLoading ? (
              <div className="empty-state">
                <RefreshCw size={32} className="animate-spin" />
                <p>Yükleniyor...</p>
              </div>
            ) : Object.keys(workingHours).length === 0 ? (
              <EmptyState message="Çalışma saati tanımlanmamış" icon={<Clock size={40} strokeWidth={1.5} />} />
            ) : (
              <div className="table-wrapper">
                <table className="table">
                  <thead>
                    <tr>
                      <th>Gün</th>
                      <th>Başlangıç – Bitiş</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(['monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday', 'sunday'] as const).map(
                      (day) => {
                        const slots = workingHours[day];
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
                      }
                    )}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
