/** 对账单导出列。期初/销售/收款/期末四个余额是这张单的核心，全部给出。 */
import type { ExportColumn } from '../types'

export interface StatementExportRow {
  customerName?: string | null
  periodStart?: string | Date | null
  periodEnd?: string | Date | null
  openingBalance?: number | null
  totalSales?: number | null
  totalPayments?: number | null
  closingBalance?: number | null
  status?: string | null
  sentAt?: string | Date | null
  orderCount?: number | null
  invoiceCount?: number | null
}

const STATUS_ZH: Record<string, string> = { draft: '草稿', sent: '已发送', confirmed: '已确认' }
const STATUS_EN: Record<string, string> = { draft: 'Draft', sent: 'Sent', confirmed: 'Confirmed' }
const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
const dateOnly = (v: unknown) => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function statementExportColumns(isEn: boolean): readonly ExportColumn<StatementExportRow>[] {
  const status = isEn ? STATUS_EN : STATUS_ZH
  return [
    { header: '客户', headerEn: 'Customer', get: r => r.customerName ?? '' },
    { header: '期间起', headerEn: 'Period Start', get: r => dateOnly(r.periodStart) },
    { header: '期间止', headerEn: 'Period End', get: r => dateOnly(r.periodEnd) },
    { header: '期初余额 (€)', headerEn: 'Opening (€)', get: r => money(r.openingBalance) },
    { header: '本期销售 (€)', headerEn: 'Sales (€)', get: r => money(r.totalSales) },
    { header: '本期收款 (€)', headerEn: 'Payments (€)', get: r => money(r.totalPayments) },
    { header: '期末余额 (€)', headerEn: 'Closing (€)', get: r => money(r.closingBalance) },
    { header: '订单数', headerEn: 'Orders', get: r => r.orderCount ?? 0 },
    { header: '发票数', headerEn: 'Invoices', get: r => r.invoiceCount ?? 0 },
    { header: '状态', headerEn: 'Status', get: r => status[String(r.status ?? '')] ?? r.status ?? '' },
    { header: '发送时间', headerEn: 'Sent At', get: r => dateOnly(r.sentAt) },
  ]
}
