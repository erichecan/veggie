/** 贷记单导出列。客户端筛选的页面，走本地导出（见 columns/invoices.ts 说明）。 */
import type { ExportColumn } from '../types'

export interface CreditNoteExportRow {
  name?: string | null
  customerName?: string | null
  creditDate?: string | Date | null
  currency?: string | null
  subtotalExTax?: number | null
  totalTax?: number | null
  totalIncTax?: number | null
  status?: string | null
  notes?: string | null
  createdBy?: string | null
}

const STATUS_ZH: Record<string, string> = {
  DRAFT: '草稿', POSTED: '已确认', APPLIED: '已抵扣', CANCELLED: '已取消',
}
const STATUS_EN: Record<string, string> = {
  DRAFT: 'Draft', POSTED: 'Posted', APPLIED: 'Applied', CANCELLED: 'Cancelled',
}
const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
const dateOnly = (v: unknown) => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function creditNoteExportColumns(isEn: boolean): readonly ExportColumn<CreditNoteExportRow>[] {
  const status = isEn ? STATUS_EN : STATUS_ZH
  return [
    { header: '贷记单号', headerEn: 'Credit Note No.', get: r => r.name ?? '' },
    { header: '客户', headerEn: 'Customer', get: r => r.customerName ?? '' },
    { header: '状态', headerEn: 'Status', get: r => status[String(r.status ?? '')] ?? r.status ?? '' },
    { header: '日期', headerEn: 'Date', get: r => dateOnly(r.creditDate) },
    { header: '币种', headerEn: 'Currency', get: r => r.currency ?? 'EUR' },
    { header: '未税金额', headerEn: 'Untaxed', get: r => money(r.subtotalExTax) },
    { header: '税额', headerEn: 'Tax', get: r => money(r.totalTax) },
    { header: '含税总额', headerEn: 'Total', get: r => money(r.totalIncTax) },
    { header: '备注', headerEn: 'Notes', get: r => r.notes ?? '' },
    { header: '创建人', headerEn: 'Created by', get: r => r.createdBy ?? '' },
  ]
}
