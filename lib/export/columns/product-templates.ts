/**
 * 商品导出列 —— 与列表页表格的列一一对应（决策 D-2：屏幕上有什么就导什么）。
 *
 * 两处**有意**与屏幕不同，都是为了让 CSV 在 Excel 里能直接用：
 *   - 金额/税率不带 € 和 % 符号，写成纯数字，单位挪到表头。带符号的话
 *     Excel 会把整列当文本，求和、排序、透视全做不了。
 *   - 日期用 yyyy-mm-dd 而不是屏幕上的 dd/mm/yyyy。后者在 Excel 里会按机器区域
 *     设置猜month/day，02/03 到底是 2 月 3 号还是 3 月 2 号取决于打开它的人。
 */
import type { ExportColumn } from '../types'

/** loader 拍平后的行形状（uom / category 已按 locale 取好名字） */
export interface ProductExportRow {
  internalRef?: string | null
  externalId?: string | null
  sequence?: number | null
  name?: string | null
  saleDescription?: string | null
  listPrice?: number | null
  customerTaxRate?: number | null
  standardPrice?: number | null
  vendorTaxRate?: number | null
  weight?: number | null
  qtyOnHand?: number | null
  forecastQty?: number | null
  categoryName?: string | null
  uomName?: string | null
  type?: string | null
  commissionPrice?: number | null
  createdBy?: string | null
  createdAt?: string | Date | null
  updatedBy?: string | null
  updatedAt?: string | Date | null
}

const TYPE_LABEL: Record<string, string> = {
  product: 'Storable Product',
  consu: 'Consumable',
  service: 'Service',
}

function fixed(v: unknown, digits: number): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  return Number.isFinite(n) ? n.toFixed(digits) : ''
}

/** 税率库里存的是小数(0.135)，屏幕上显示 13.5% —— 导出成 13.5，表头标 (%) */
function taxPercent(v: unknown): string {
  if (v === null || v === undefined || v === '') return ''
  const n = Number(v)
  if (!Number.isFinite(n)) return ''
  return String(Number((n * 100).toFixed(2)))
}

function isoDate(v: unknown): string {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export const PRODUCT_TEMPLATE_EXPORT_COLUMNS: readonly ExportColumn<ProductExportRow>[] = [
  { header: 'Internal Reference', get: r => r.internalRef ?? '' },
  { header: 'ID', get: r => r.externalId ?? '' },
  { header: 'Sequence', get: r => r.sequence ?? '' },
  { header: 'Name', get: r => r.name ?? '' },
  { header: 'Sale Description', get: r => r.saleDescription ?? '' },
  { header: 'Sale Price (€)', get: r => fixed(r.listPrice, 2) },
  { header: 'Customer Taxes (%)', get: r => taxPercent(r.customerTaxRate) },
  { header: 'Cost (€)', get: r => fixed(r.standardPrice ?? 0, 2) },
  { header: 'Vendor Taxes (%)', get: r => taxPercent(r.vendorTaxRate) },
  { header: 'Weight (kg)', get: r => fixed(r.weight, 2) },
  { header: 'Quantity On Hand', get: r => fixed(r.qtyOnHand ?? 0, 1) },
  { header: 'Forecast Quantity', get: r => fixed(r.forecastQty ?? 0, 1) },
  { header: 'Product Category', get: r => r.categoryName ?? '' },
  { header: 'Unit of Measure', get: r => r.uomName ?? '' },
  { header: 'Product Type', get: r => TYPE_LABEL[String(r.type ?? '').toLowerCase()] ?? (r.type ?? '') },
  { header: 'Commission Price (€)', get: r => fixed(r.commissionPrice, 2) },
  { header: 'Created by', get: r => r.createdBy ?? 'Administrator' },
  { header: 'Created on', get: r => isoDate(r.createdAt) },
  { header: 'Last Updated by', get: r => r.updatedBy ?? 'Administrator' },
  { header: 'Last Updated on', get: r => isoDate(r.updatedAt) },
]
