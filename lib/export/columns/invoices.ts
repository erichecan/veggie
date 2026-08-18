/**
 * 发票导出列 —— 与列表页表头一一对应。
 *
 * 发票页是「全量拉到前端 + 客户端筛选」，所以导出走客户端模式：用这份列定义把
 * 屏幕上已筛好的行转 CSV。⛔ 不能改走 /api/export/<entity> —— 服务端不认识那些
 * 客户端筛选条件，结果会是「导出全部」而屏幕只显示一部分。
 * 见 docs/20260818-global-csv-export-design-and-tasks.md §4.3
 */
import type { ExportColumn } from '../types'
import type { Invoice } from '@/lib/types'

const STATUS_ZH: Record<string, string> = {
  draft: '草稿', posted: '已确认', paid: '已付款', cancelled: '已取消',
}
const STATUS_EN: Record<string, string> = {
  draft: 'Draft', posted: 'Posted', paid: 'Paid', cancelled: 'Cancelled',
}
const TERM_ZH: Record<string, string> = { cash: '现付', weekly: '周结', monthly: '月结' }
const TERM_EN: Record<string, string> = { cash: 'Cash', weekly: 'Weekly', monthly: 'Monthly' }

const money = (v: unknown) => (v === null || v === undefined ? '' : Number(v).toFixed(2))
const dateOnly = (v: unknown) => {
  if (!v) return ''
  const d = v instanceof Date ? v : new Date(String(v))
  return Number.isNaN(d.getTime()) ? '' : d.toISOString().slice(0, 10)
}

export function invoiceExportColumns(isEn: boolean): readonly ExportColumn<Invoice>[] {
  const status = isEn ? STATUS_EN : STATUS_ZH
  const term = isEn ? TERM_EN : TERM_ZH
  return [
    { header: '发票号', headerEn: 'Invoice No.', get: i => i.name ?? '' },
    { header: '客户', headerEn: 'Customer', get: i => i.customerName ?? '' },
    { header: '状态', headerEn: 'Status', get: i => status[String(i.status)] ?? i.status },
    { header: '未税金额 (€)', headerEn: 'Untaxed (€)', get: i => money(i.subtotalExTax) },
    { header: '税额 (€)', headerEn: 'Tax (€)', get: i => money(i.totalTax) },
    { header: '含税总额 (€)', headerEn: 'Total (€)', get: i => money(i.totalIncTax) },
    { header: '已收款 (€)', headerEn: 'Paid (€)', get: i => money(i.amountPaid) },
    { header: '待收款 (€)', headerEn: 'Amount Due (€)', get: i => money(i.amountDue) },
    { header: '结款方式', headerEn: 'Payment Terms', get: i => term[String(i.paymentTerms)] ?? i.paymentTerms },
    { header: '到期日', headerEn: 'Due Date', get: i => dateOnly(i.dueDate) },
    { header: '创建时间', headerEn: 'Created At', get: i => dateOnly(i.createdAt) },
  ]
}
