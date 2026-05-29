// CSV loading is in prisma/csv-loader.ts (server-only).

// ---------------------------------------------------------------------------
// CSV Customer shape (no specialPrices — those are handled separately)
// ---------------------------------------------------------------------------
export interface CsvCustomer {
  id: string
  externalId: string
  name: string
  city: string
  address: string
  phone: string
  email: string
  vatNumber: string
  paymentTerm: string
  creditLimit?: number
  commissionRate?: number
  notes: string | null
  pricelistId: string | null
  specialPrices?: never[]
}

// ---------------------------------------------------------------------------
// Two demo customers whose IDs are referenced by SEED_USERS
// (restaurant1@veggie.com → cust_001, restaurant2@veggie.com → cust_002)
// These are kept even when CSV customers are loaded so logins still work.
// ---------------------------------------------------------------------------
export const SEED_DEMO_CUSTOMERS: CsvCustomer[] = [
  {
    id: 'cust_001',
    externalId: '__demo__.res_partner_001',
    name: 'Achara',
    address: 'Temple Bar, Dublin 2',
    city: 'Dublin',
    phone: '+353 1 671 0000',
    email: 'orders@achara.ie',
    vatNumber: 'IE1001001A',
    paymentTerm: 'weekly',
    creditLimit: 1000,
    commissionRate: 0.05,
    pricelistId: 'pl_44',
    notes: 'Temple Bar 旗舰店，每周一结算',
  },
  {
    id: 'cust_002',
    externalId: '__demo__.res_partner_002',
    name: 'AE D5',
    address: 'Dublin 5',
    city: 'Dublin',
    phone: '+353 1 833 0000',
    email: 'supply@aed5.ie',
    vatNumber: 'IE2002002B',
    paymentTerm: 'cash',
    pricelistId: 'pl_44',
    notes: 'Dublin 5 外卖店，现付',
  },
]

// ---------------------------------------------------------------------------
// Legacy export — kept for any code that still imports SEED_CUSTOMERS
// Returns demo customers only (CSV customers loaded dynamically in seed.ts)
// ---------------------------------------------------------------------------
export const SEED_CUSTOMERS = SEED_DEMO_CUSTOMERS
