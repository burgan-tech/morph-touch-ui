import { createContext, useContext, useState, useCallback, type ReactNode } from 'react';

export type CustomerSegment = 'Private' | 'Private Plus';

interface CustomerState {
  customerId: string | null;
  segment: CustomerSegment | null;
}

interface CustomerContextValue extends CustomerState {
  setCustomer: (customerId: string, segment: CustomerSegment) => void;
  clearCustomer: () => void;
}

const KEYS = {
  id: 'wealth-app-customer-id',
  segment: 'wealth-app-customer-segment',
} as const;

function loadFromStorage(): CustomerState {
  const customerId = localStorage.getItem(KEYS.id);
  const rawSegment = localStorage.getItem(KEYS.segment);
  const segment = rawSegment === 'Private' || rawSegment === 'Private Plus' ? rawSegment : null;
  return { customerId, segment };
}

const CustomerContext = createContext<CustomerContextValue | null>(null);

export function CustomerProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<CustomerState>(loadFromStorage);

  const setCustomer = useCallback((customerId: string, segment: CustomerSegment) => {
    localStorage.setItem(KEYS.id, customerId);
    localStorage.setItem(KEYS.segment, segment);
    setState({ customerId, segment });
  }, []);

  const clearCustomer = useCallback(() => {
    localStorage.removeItem(KEYS.id);
    localStorage.removeItem(KEYS.segment);
    setState({ customerId: null, segment: null });
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
