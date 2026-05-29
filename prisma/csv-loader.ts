/**
 * csv-loader.ts — server-only CSV parsers for seed data.
 * Never import this from client components.
 */
import fs from 'fs'
import path from 'path'
import { SEED_CATEGORIES } from '../lib/seed-products'
import { SEED_PRICELISTS } from '../lib/seed-pricelists'

// ─── Category / Tax lookup tables ─────────────────────────────────────────────

const CAT_ID: Record<string, string> = Object.fromEntries(
  SEED_CATEGORIES.filter(c => c.externalId).map(c => [c.externalId!, c.id])
)

const CUSTOMER_TAX: Record<string, number> = {
  '__export__.account_tax_4_2705eab1':    0.135,
  '__export__.account_tax_3_42b1e19b':    0.23,
  'l10n_generic_coa.1_sale_tax_template': 0.20,
}

const VENDOR_TAX: Record<string, number> = {
  '__export__.account_tax_6_cba05c03':         0.135,
  '__export__.account_tax_5_1e4e1f1d':         0.23,
  'l10n_generic_coa.1_purchase_tax_template':  0.20,
}

// ─── Pricelist lookup ─────────────────────────────────────────────────────────

const PRICELIST_MAP: Record<string, string> = {}
for (const pl of SEED_PRICELISTS) {
  if (pl.externalId) PRICELIST_MAP[pl.externalId] = pl.id
}
PRICELIST_MAP['product.list0'] = 'pl_44'

// ─── CSV parsers ──────────────────────────────────────────────────────────────

function parseCsvFull(content: string): Record<string, string>[] {
  const records: Record<string, string>[] = []
  let headers: string[] = []
  let fields: string[] = []
  let cur = ''
  let inQuote = false

  for (let i = 0; i < content.length; i++) {
    const ch = content[i]

    if (ch === '"') {
      if (inQuote && content[i + 1] === '"') { cur += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      fields.push(cur); cur = ''
    } else if ((ch === '\n' || ch === '\r') && !inQuote) {
      if (ch === '\r' && content[i + 1] === '\n') i++
      fields.push(cur); cur = ''
      if (fields.length > 1 || fields[0]) {
        if (headers.length === 0) { headers = fields.slice() }
        else {
          const rec: Record<string, string> = {}
          headers.forEach((h, idx) => { rec[h] = fields[idx] ?? '' })
          records.push(rec)
        }
      }
      fields = []
    } else {
      cur += ch
    }
  }
  if (fields.length > 0 || cur) {
    fields.push(cur)
    if (headers.length > 0 && fields.length > 1) {
      const rec: Record<string, string> = {}
      headers.forEach((h, idx) => { rec[h] = fields[idx] ?? '' })
      records.push(rec)
    }
  }
  return records
}

function parseCSVLine(line: string): string[] {
  const result: string[] = []
  let inQuote = false
  let current = ''
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuote && line[i + 1] === '"') { current += '"'; i++ }
      else inQuote = !inQuote
    } else if (ch === ',' && !inQuote) {
      result.push(current); current = ''
    } else {
      current += ch
    }
  }
  result.push(current)
  return result
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function toFloat(s: string | undefined, fallback = 0): number {
  const n = parseFloat(s ?? ''); return isNaN(n) ? fallback : n
}
function toFloatOrNull(s: string | undefined): number | null {
  const t = s?.trim(); if (!t) return null; const n = parseFloat(t); return isNaN(n) ? null : n
}
function toIntOrNull(s: string | undefined): number | null {
  const t = s?.trim(); if (!t) return null; const n = parseInt(t, 10); return isNaN(n) ? null : n
}
function odooNum(externalId: string): string {
  const m = externalId.match(/product_product_(\d+)/)
  return m ? m[1] : externalId.replace(/[^a-zA-Z0-9]/g, '').slice(-12)
}

// ─── Public types (re-exported for prisma/seed.ts) ────────────────────────────

export interface CsvProductRow {
  tmplId: string
  prodId: string
  externalId: string
  name: string
  internalRef: string | null
  listPrice: number
  standardPrice: number
  commissionPrice: number | null
  customerTaxRate: number
  vendorTaxRate: number | null
  forecastQty: number | null
  qtyOnHand: number
  categoryId: string | null
  type: 'PRODUCT' | 'CONSU' | 'SERVICE'
  saleDescription: string | null
  sequence: number | null
  weight: number | null
  createdAt: string
  createdBy: string | null
  updatedBy: string | null
}

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

// ─── Loaders ──────────────────────────────────────────────────────────────────

export function loadCsvProducts(csvPath?: string): CsvProductRow[] {
  const filePath = csvPath ?? path.join(process.cwd(), 'pic/product.product.csv')
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  Product CSV not found at ${filePath}, skipping`)
    return []
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  const rows = parseCsvFull(content)
  const products: CsvProductRow[] = []

  for (const r of rows) {
    const externalId = r['External ID']?.trim()
    const name       = r['Name']?.trim()
    if (!externalId || !name) continue

    const num    = odooNum(externalId)
    const tmplId = `tmpl_p${num}`
    const prodId = `p${num}`

    const rawType = (r['Product Type'] ?? '').trim().toLowerCase()
    const type: CsvProductRow['type'] =
      rawType === 'consu' ? 'CONSU' : rawType === 'service' ? 'SERVICE' : 'PRODUCT'

    const catExt    = r['Product Category']?.trim()
    const categoryId = catExt ? (CAT_ID[catExt] ?? 'cat_00') : null

    const ctExt = r['Customer Taxes']?.trim()
    const vtExt = r['Vendor Taxes']?.trim()
    const customerTaxRate: number      = ctExt ? (CUSTOMER_TAX[ctExt] ?? 0) : 0
    const vendorTaxRate:   number|null = vtExt ? (VENDOR_TAX[vtExt]  ?? null) : null

    const createdOnRaw = r['Created on']?.trim()
    let createdAt: string
    try {
      createdAt = createdOnRaw
        ? new Date(createdOnRaw.replace(' ', 'T') + 'Z').toISOString()
        : new Date().toISOString()
    } catch { createdAt = new Date().toISOString() }

    products.push({
      tmplId, prodId, externalId, name,
      internalRef:     r['Internal Reference']?.trim() || null,
      listPrice:       toFloat(r['Sale Price']),
      standardPrice:   toFloat(r['Cost']),
      commissionPrice: toFloatOrNull(r['Commission Price']),
      customerTaxRate,
      vendorTaxRate,
      forecastQty:     toFloatOrNull(r['Forecast Quantity']),
      qtyOnHand:       toFloat(r['Quantity On Hand']),
      categoryId,
      type,
      saleDescription: r['Sale Description']?.trim() || null,
      sequence:        toIntOrNull(r['Sequence']),
      weight:          toFloatOrNull(r['Weight']),
      createdAt,
      createdBy:  r['Created by']?.trim()      || null,
      updatedBy:  r['Last Updated by']?.trim() || null,
    })
  }
  return products
}

export function loadCsvCustomers(csvPath?: string): CsvCustomer[] {
  const filePath = csvPath ?? path.join(process.cwd(), 'pic/res.partner.csv')
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  CSV not found at ${filePath}, skipping CSV customers`)
    return []
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  const lines = content.split('\n').map(l => l.trim()).filter(Boolean)
  const customers: CsvCustomer[] = []

  for (const line of lines.slice(1)) {
    const cols = parseCSVLine(line)
    if (cols.length < 2) continue

    const externalId  = cols[0]?.trim() ?? ''
    const displayName = cols[1]?.trim() ?? ''
    const city        = cols[2]?.trim() ?? ''
    const notes       = cols[5]?.trim() || null
    const pricelist   = cols[7]?.trim() ?? ''
    const street      = cols[8]?.trim() ?? ''

    if (!externalId || !displayName) continue

    const numMatch = externalId.match(/res_partner_(\d+)/)
    const stableId = numMatch
      ? `cust_${numMatch[1]}`
      : `cust_x_${Buffer.from(externalId).toString('hex').slice(0, 12)}`

    const pricelistId = pricelist ? (PRICELIST_MAP[pricelist] ?? null) : null

    customers.push({
      id: stableId, externalId, name: displayName, city,
      address: street, phone: '', email: '', vatNumber: '',
      paymentTerm: 'monthly', notes, pricelistId,
    })
  }
  return customers
}
