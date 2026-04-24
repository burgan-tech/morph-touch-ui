import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type AdvisorType = 'PM' | 'IA';

interface AdvisorState {
  advisorId: string | null;
  advisorType: AdvisorType | null;
  advisorName: string | null;
}

interface AdvisorContextValue extends AdvisorState {
  setAdvisor: (id: string, type: AdvisorType, name: string) => void;
  clearAdvisor: () => void;
}

const KEYS = {
  id: 'wealth-app-advisor-id',
  type: 'wealth-app-advisor-type',
  name: 'wealth-app-advisor-name',
} as const;

function normalizeAdvisorId(id: string | null): string | null {
  if (!id) return id;
  return id.replace('invesment-advisor', 'investment-advisor');
}

function loadFromStorage(): AdvisorState {
  const rawId = localStorage.getItem(KEYS.id);
  const advisorId = normalizeAdvisorId(rawId);
  const rawType = localStorage.getItem(KEYS.type);
  const advisorName = localStorage.getItem(KEYS.name);
  const advisorType = rawType === 'PM' || rawType === 'IA' ? rawType : null;
  return { advisorId, advisorType, advisorName };
}

const AdvisorContext = createContext<AdvisorContextValue | null>(null);

export function AdvisorProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AdvisorState>(loadFromStorage);

  const setAdvisor = useCallback((id: string, type: AdvisorType, name: string) => {
    const normalizedId = normalizeAdvisorId(id) ?? id;
    localStorage.setItem(KEYS.id, normalizedId);
    localStorage.setItem(KEYS.type, type);
    localStorage.setItem(KEYS.name, name);
    setState({ advisorId: normalizedId, advisorType: type, advisorName: name });
  }, []);

  const clearAdvisor = useCallback(() => {
    localStorage.removeItem(KEYS.id);
    localStorage.removeItem(KEYS.type);
    localStorage.removeItem(KEYS.name);
    setState({ advisorId: null, advisorType: null, advisorName: null });
  }, []);

  return (
    <AdvisorContext.Provider value={{ ...state, setAdvisor, clearAdvisor }}>
      {children}
    </AdvisorContext.Provider>
  );
}

export function useAdvisorContext(): AdvisorContextValue {
  const ctx = useContext(AdvisorContext);
  if (!ctx) throw new Error('useAdvisorContext must be used within AdvisorProvider');
  return ctx;
}
