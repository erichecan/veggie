/**
 * 供应商账单导出列。与发票一样是客户端筛选的页面，走本地导出（见 columns/invoices.ts 说明）。
 * 金额同时给原币与币种列 —— 供应商账单有外币（currency + exchangeRate）。
 */
import type { ExportColumn } from '../types'

export interface VendorBillExportRow {
  name?: string | null
  supplierName?: string | null
  billDate?: string | Date | null
  dueDate?: string | Date | null
  currency?: string | null
  subtotalExTax?: number | null
  totalTax?: number | null
  totalIncTax?: number | null
  amountPaid?: number | null
  amountDue?: number | null
  status?: string | null
  purchaseOrderName?: string | null
}

const STATUS_ZH: Record<string, string> = {
  DRAFT: '草稿', POSTED: '已确认', PAID: '已付款', PARTIAL: '部分付款', CANCELLED: '已取消',
}
const STATUS_EN: Record<string, string> = {
  DRAFT: 'Draft', POSTED: 'Posted', PAID: 'Paid', PARTIAL: 'Partially Paid', CANCELLED: 'Cancelled',
}
const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
const dateOnly = (v: unknown) => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function vendorBillExportColumns(isEn: boolean): readonly ExportColumn<VendorBillExportRow>[] {
  const status = isEn ? STATUS_EN : STATUS_ZH
  return [
    { header: '账单号', headerEn: 'Bill No.', get: r => r.name ?? '' },
    { header: '供应商', headerEn: 'Supplier', get: r => r.supplierName ?? '' },
    { header: '关联采购单', headerEn: 'Purchase Order', get: r => r.purchaseOrderName ?? '' },
    { header: '状态', headerEn: 'Status', get: r => status[String(r.status ?? '')] ?? r.status ?? '' },
    { header: '账单日期', headerEn: 'Bill Date', get: r => dateOnly(r.billDate) },
    { header: '到期日', headerEn: 'Due Date', get: r => dateOnly(r.dueDate) },
    { header: '币种', headerEn: 'Currency', get: r => r.currency ?? 'EUR' },
    { header: '未税金额', headerEn: 'Untaxed', get: r => money(r.subtotalExTax) },
    { header: '税额', headerEn: 'Tax', get: r => money(r.totalTax) },
    { header: '含税总额', headerEn: 'Total', get: r => money(r.totalIncTax) },
    { header: '已付款', headerEn: 'Paid', get: r => money(r.amountPaid) },
    { header: '待付款', headerEn: 'Amount Due', get: r => money(r.amountDue) },
  ]
}
