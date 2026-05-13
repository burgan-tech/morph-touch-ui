import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type CustomerSegment = 'Private' | 'Private Plus';

interface CustomerState {
  customerId: string | null;
  segment: CustomerSegment | null;
  // Optional explicit PM/IA assignment carried alongside the customer record
  // (see `data/customers.ts`). The Dashboard surfaces these advisor sicils
  // (e.g. U02917 / U000513) so chat rooms can be opened against the right
  // PM/IA without relying on any implicit naming convention.
  pmKey: string | null;
  iaKey: string | null;
  // Human-readable display name (e.g. "ABDURRAHMAN KIRANLI"). When present,
  // surfaced in place of the TCKN/customerId in the Topbar.
  customerName: string | null;
}

interface CustomerContextValue extends CustomerState {
  setCustomer: (
    customerId: string,
    segment: CustomerSegment,
    pmKey?: string,
    iaKey?: string,
    customerName?: string,
  ) => void;
  clearCustomer: () => void;
}

const KEYS = {
  id: 'wealth-app-customer-id',
  segment: 'wealth-app-customer-segment',
  pmKey: 'wealth-app-customer-pm',
  iaKey: 'wealth-app-customer-ia',
  name: 'wealth-app-customer-name',
} as const;

function loadFromStorage(): CustomerState {
  const customerId = localStorage.getItem(KEYS.id);
  const rawSegment = localStorage.getItem(KEYS.segment);
  const segment = rawSegment === 'Private' || rawSegment === 'Private Plus' ? rawSegment : null;
  const pmKey = localStorage.getItem(KEYS.pmKey);
  const iaKey = localStorage.getItem(KEYS.iaKey);
  const customerName = localStorage.getItem(KEYS.name);
  return {
    customerId,
    segment,
    pmKey: pmKey && pmKey.length > 0 ? pmKey : null,
    iaKey: iaKey && iaKey.length > 0 ? iaKey : null,
    customerName: customerName && customerName.length > 0 ? customerName : null,
  };
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomerState>(loadFromStorage);

  const setCustomer = useCallback(
    (
      customerId: string,
      segment: CustomerSegment,
      pmKey?: string,
      iaKey?: string,
      customerName?: string,
    ) => {
      localStorage.setItem(KEYS.id, customerId);
      localStorage.setItem(KEYS.segment, segment);
      if (pmKey) localStorage.setItem(KEYS.pmKey, pmKey);
      else localStorage.removeItem(KEYS.pmKey);
      if (iaKey) localStorage.setItem(KEYS.iaKey, iaKey);
      else localStorage.removeItem(KEYS.iaKey);
      if (customerName) localStorage.setItem(KEYS.name, customerName);
      else localStorage.removeItem(KEYS.name);
      setState({
        customerId,
        segment,
        pmKey: pmKey ?? null,
        iaKey: iaKey ?? null,
        customerName: customerName ?? null,
      });
    },
    [],
  );

  const clearCustomer = useCallback(() => {
    localStorage.removeItem(KEYS.id);
    localStorage.removeItem(KEYS.segment);
    localStorage.removeItem(KEYS.pmKey);
    localStorage.removeItem(KEYS.iaKey);
    localStorage.removeItem(KEYS.name);
    setState({
      customerId: null,
      segment: null,
      pmKey: null,
      iaKey: null,
      customerName: null,
    });
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
