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

// ─── Helpers ──────────────────────────────────────────────────────────────────

/**
 * 按表头别名取值，返回第一个非空的。
 *
 * 存在的理由：pic/ 下的 Odoo 导出在 20260715 换过格式——从「人类可读表头」
 * （External ID / Name / Sale Price）换成了「技术字段名」（id / name / lst_price），
 * 旧文件被挪进 pic/backup-20260715/。当时没有同步改这里，于是 loadCsvProducts
 * 的每一行都在 `!externalId || !name` 处被静默丢弃，db:seed 连续一个月产出
 * 0 个商品；loadCsvCustomers 更糟——它按列序号读，新格式下第 2 列由 Display Name
 * 变成了 price_type，于是 1325 个客户的名字全被写成了「Multi Price」。
 *
 * 两种表头都认，就不会再因为换一次导出格式而悄无声息地烂掉。
 */
function pick(row: Record<string, string>, ...aliases: string[]): string | undefined {
  for (const key of aliases) {
    const v = row[key]
    if (v !== undefined && v.trim() !== '') return v.trim()
  }
  return undefined
}

/**
 * 文件读到了行、却一行都没解析出来 —— 这是表头对不上的典型症状。
 * 必须响亮地失败：静默返回空数组正是上面那个 bug 活了一个月的原因。
 */
function assertParsed(label: string, filePath: string, rawRows: number, usableRows: number): void {
  if (rawRows > 0 && usableRows === 0) {
    throw new Error(
      `${label}: 从 ${filePath} 读到 ${rawRows} 行，但一行都解析不出来。` +
      `多半是导出表头变了（本 loader 同时支持人类可读表头与 Odoo 技术字段名）。`
    )
  }
}

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
  pricelistIds: string[]
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
    const externalId = pick(r, 'External ID', 'id')
    const name       = pick(r, 'Name', 'name')
    if (!externalId || !name) continue

    const num    = odooNum(externalId)
    const tmplId = `tmpl_p${num}`
    const prodId = `p${num}`

    const rawType = (pick(r, 'Product Type', 'type') ?? '').toLowerCase()
    const type: CsvProductRow['type'] =
      rawType === 'consu' ? 'CONSU' : rawType === 'service' ? 'SERVICE' : 'PRODUCT'

    const catExt    = pick(r, 'Product Category', 'categ_id/id')
    const categoryId = catExt ? (CAT_ID[catExt] ?? 'cat_00') : null

    const ctExt = pick(r, 'Customer Taxes', 'taxes_id/id')
    const vtExt = pick(r, 'Vendor Taxes', 'supplier_taxes_id/id')
    const customerTaxRate: number      = ctExt ? (CUSTOMER_TAX[ctExt] ?? 0) : 0
    const vendorTaxRate:   number|null = vtExt ? (VENDOR_TAX[vtExt]  ?? null) : null

    const createdOnRaw = pick(r, 'Created on')
    let createdAt: string
    try {
      createdAt = createdOnRaw
        ? new Date(createdOnRaw.replace(' ', 'T') + 'Z').toISOString()
        : new Date().toISOString()
    } catch { createdAt = new Date().toISOString() }

    products.push({
      tmplId, prodId, externalId, name,
      internalRef:     pick(r, 'Internal Reference', 'default_code') ?? null,
      listPrice:       toFloat(pick(r, 'Sale Price', 'lst_price')),
      standardPrice:   toFloat(pick(r, 'Cost', 'standard_price')),
      commissionPrice: toFloatOrNull(pick(r, 'Commission Price', 'commission_price_product')),
      customerTaxRate,
      vendorTaxRate,
      forecastQty:     toFloatOrNull(pick(r, 'Forecast Quantity')),
      // 技术字段格式的导出不带库存列 → 落 0，由 db:seed:events 之类的步骤单独铺库存
      qtyOnHand:       toFloat(pick(r, 'Quantity On Hand')),
      categoryId,
      type,
      saleDescription: pick(r, 'Sale Description', 'description_sale') ?? null,
      sequence:        toIntOrNull(pick(r, 'Sequence', 'sequence')),
      weight:          toFloatOrNull(pick(r, 'Weight', 'weight')),
      createdAt,
      createdBy:  pick(r, 'Created by')      ?? null,
      updatedBy:  pick(r, 'Last Updated by') ?? null,
    })
  }
  assertParsed('loadCsvProducts', filePath, rows.length, products.length)
  return products
}

export function loadCsvCustomers(csvPath?: string): CsvCustomer[] {
  const filePath = csvPath ?? path.join(process.cwd(), 'pic/res.partner.csv')
  if (!fs.existsSync(filePath)) {
    console.warn(`⚠️  CSV not found at ${filePath}, skipping CSV customers`)
    return []
  }
  const content = fs.readFileSync(filePath, 'utf-8')
  // 按表头解析而不是按列序号：列序号在 20260715 换导出格式时整体错位，
  // 把 price_type 当成了客户名。顺带 parseCsvFull 能正确处理引号内的换行。
  const rows = parseCsvFull(content)
  const customers: CsvCustomer[] = []

  for (const r of rows) {
    const externalId  = pick(r, 'External ID', 'id')
    const displayName = pick(r, 'Display Name', 'name')
    if (!externalId || !displayName) continue

    const city      = pick(r, 'City', 'city') ?? ''
    const street    = pick(r, 'Street', 'street') ?? ''
    const notes     = pick(r, 'Notes', 'comment') ?? null
    const pricelist = pick(r, 'Pricelist', 'property_product_pricelist/id')

    const numMatch = externalId.match(/res_partner_(\d+)/)
    const stableId = numMatch
      ? `cust_${numMatch[1]}`
      : `cust_x_${Buffer.from(externalId).toString('hex').slice(0, 12)}`

    const pricelistId = pricelist ? (PRICELIST_MAP[pricelist] ?? null) : null

    customers.push({
      id: stableId, externalId, name: displayName, city,
      address: street,
      phone: pick(r, 'Phone', 'phone') ?? '',
      email: pick(r, 'Email', 'email') ?? '',
      vatNumber: '',
      paymentTerm: 'monthly', notes, pricelistIds: pricelistId ? [pricelistId] : [],
    })
  }
  assertParsed('loadCsvCustomers', filePath, rows.length, customers.length)
  return customers
}
