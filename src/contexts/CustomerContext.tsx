import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type CustomerSegment = 'Private' | 'Private Plus';

interface CustomerState {
  customerId: string | null;
  segment: CustomerSegment | null;
  // Optional explicit PM/IA assignment. When omitted, the customer Dashboard
  // falls back to the legacy convention of `pm{num}` / `ia{num}` derived from
  // the customer id (user001 → pm001/ia001 …). Used for test customers whose
  // advisors don't follow that 1-1 mapping (e.g. user004 → pm003/ia002).
  pmKey: string | null;
  iaKey: string | null;
}

interface CustomerContextValue extends CustomerState {
  setCustomer: (
    customerId: string,
    segment: CustomerSegment,
    pmKey?: string,
    iaKey?: string,
  ) => void;
  clearCustomer: () => void;
}

const KEYS = {
  id: 'wealth-app-customer-id',
  segment: 'wealth-app-customer-segment',
  pmKey: 'wealth-app-customer-pm',
  iaKey: 'wealth-app-customer-ia',
} as const;

function loadFromStorage(): CustomerState {
  const customerId = localStorage.getItem(KEYS.id);
  const rawSegment = localStorage.getItem(KEYS.segment);
  const segment = rawSegment === 'Private' || rawSegment === 'Private Plus' ? rawSegment : null;
  const pmKey = localStorage.getItem(KEYS.pmKey);
  const iaKey = localStorage.getItem(KEYS.iaKey);
  return {
    customerId,
    segment,
    pmKey: pmKey && pmKey.length > 0 ? pmKey : null,
    iaKey: iaKey && iaKey.length > 0 ? iaKey : null,
  };
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomerState>(loadFromStorage);

  const setCustomer = useCallback(
    (customerId: string, segment: CustomerSegment, pmKey?: string, iaKey?: string) => {
      localStorage.setItem(KEYS.id, customerId);
      localStorage.setItem(KEYS.segment, segment);
      if (pmKey) localStorage.setItem(KEYS.pmKey, pmKey);
      else localStorage.removeItem(KEYS.pmKey);
      if (iaKey) localStorage.setItem(KEYS.iaKey, iaKey);
      else localStorage.removeItem(KEYS.iaKey);
      setState({
        customerId,
        segment,
        pmKey: pmKey ?? null,
        iaKey: iaKey ?? null,
      });
    },
    [],
  );

  const clearCustomer = useCallback(() => {
    localStorage.removeItem(KEYS.id);
    localStorage.removeItem(KEYS.segment);
    localStorage.removeItem(KEYS.pmKey);
    localStorage.removeItem(KEYS.iaKey);
    setState({ customerId: null, segment: null, pmKey: null, iaKey: null });
  }, []);

  return (
    <CustomerContext.Provider value={{ ...state, setCustomer, clearCustomer }}>
      {children}
    </CustomerContext.Provider>
  );
}

export function useCustomerContext(): CustomerContextValue {
  const ctx = useContext(CustomerContext);
  if (!ctx) throw new Error('useCustomerContext must be used within CustomerProvider');
  return ctx;
}
