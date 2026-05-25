import type { CustomerSegment } from '../contexts/CustomerContext';

/**
 * Demo / mock customer roster used by the role selector and the advisor-facing
 * chat (so the TCKN can be replaced with a human-readable name in the UI).
 *
 * Keep this list in sync with whichever fixtures the runtime / Matrix server
 * is seeded with. There is intentionally no `customer` workflow in
 * morph-touch, so the runtime is not the source of truth for these names.
 */
export interface CustomerMock {
  customerId: string;
  segment: CustomerSegment;
  label: string;
  /** Explicit advisor sicil assignment (e.g. U02917 / U000513). */
  pmKey?: string;
  iaKey?: string;
}

export const CUSTOMERS: CustomerMock[] = [
  {
    // Atanmış (statik) PM/IA sicilleri. Müşterinin Dashboard'da gerçekte
    // gördüğü PM/IA runtime'daki aktif chat-room'a göre belirlenir; eğer
    // aktif odanın advisor'ı buradan farklıysa DB'den gelen değer ekranda
    // bu fixture'ı ezer (bkz. pages/customer/Dashboard.tsx).
    customerId: '10928922766',
    segment: 'Private',
    label: 'ABDURRAHMAN KIRANLI',
    pmKey: 'U02917',
    iaKey: 'U000513',
  },
  {
    customerId: '28727063702',
    segment: 'Private Plus',
    label: 'EMİNE CEREN',
    pmKey: 'U01252',
    iaKey: 'U000513',
  },
];

const BY_ID = new Map(CUSTOMERS.map((c) => [c.customerId, c]));

/**
 * Resolve a customer's display name from its TCKN/login id. Returns `undefined`
 * when the id is not in the mock roster so the caller can decide whether to
 * fall back to the raw id.
 */
export function getCustomerName(customerId: string | null | undefined): string | undefined {
  if (!customerId) return undefined;
  return BY_ID.get(customerId)?.label;
}

/** Same as {@link getCustomerName}, but never returns `undefined`. */
export function customerDisplayName(customerId: string | null | undefined): string {
  return getCustomerName(customerId) ?? (customerId ?? '—');
}
