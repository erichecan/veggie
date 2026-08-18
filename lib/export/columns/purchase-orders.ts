/**
 * 采购单导出列。金额同时给原币与欧元 —— 采购有外币单（currency/exchangeRate），
 * 只导一种会让财务对不上账。
 */
import type { ExportColumn } from '../types'

export interface PurchaseOrderExportRow {
  name?: string | null
  supplierName?: string | null
  status?: string | null
  orderDate?: string | Date | null
  expectedDate?: string | Date | null
  currency?: string | null
  subtotalExTax?: number | null
  totalTax?: number | null
  totalIncTax?: number | null
  totalIncTaxEur?: number | null
  freightAmount?: number | null
  lineCount?: number | null
}

const STATUS_ZH: Record<string, string> = {
  DRAFT: '询价单', SENT: '已发送', CONFIRMED: '已确认',
  RECEIVED: '已收货', INVOICED: '已开票', CANCELLED: '已取消',
}
const STATUS_EN: Record<string, string> = {
  DRAFT: 'RFQ', SENT: 'Sent', CONFIRMED: 'Confirmed',
  RECEIVED: 'Received', INVOICED: 'Invoiced', CANCELLED: 'Cancelled',
}

const money = (v: unknown) =>
  v === null || v === undefined || v === '' ? '' : Number(v).toFixed(2)
const dateOnly = (v: unknown) => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function purchaseOrderExportColumns(isEn: boolean): readonly ExportColumn<PurchaseOrderExportRow>[] {
  const status = isEn ? STATUS_EN : STATUS_ZH
  return [
    { header: '采购单号', headerEn: 'PO No', get: r => r.name ?? '' },
    { header: '供应商', headerEn: 'Supplier', get: r => r.supplierName ?? '' },
    { header: '状态', headerEn: 'Status', get: r => status[String(r.status ?? '')] ?? r.status ?? '' },
    { header: '下单日期', headerEn: 'Order Date', get: r => dateOnly(r.orderDate) },
    { header: '预计到货', headerEn: 'Expected Date', get: r => dateOnly(r.expectedDate) },
    { header: '行数', headerEn: 'Lines', get: r => r.lineCount ?? 0 },
    { header: '币种', headerEn: 'Currency', get: r => r.currency ?? 'EUR' },
    { header: '未税金额', headerEn: 'Untaxed', get: r => money(r.subtotalExTax) },
    { header: '税额', headerEn: 'Tax', get: r => money(r.totalTax) },
    { header: '运费', headerEn: 'Freight', get: r => money(r.freightAmount) },
    { header: '含税总额', headerEn: 'Total', get: r => money(r.totalIncTax) },
    // 外币单才有换算值；本币单留空而不是抄一遍总额，免得看不出哪些是换算过的
    { header: '含税总额 (€)', headerEn: 'Total (€)', get: r => money(r.totalIncTaxEur) },
  ]
}
