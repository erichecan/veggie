/**
 * 「日报（按客户）/明细清单/商品×星期汇总」三种打印报表的 HTML 构建函数——
 * 服务端 PDF 路由（app/api/print/day-wise-report-pdf）专用，server-safe（无 'use client'）。
 * 客户反馈(20260718)：老版本走客户端 window.print()，浏览器自己在页面上下加的默认页头页脚
 * (打印时间/文档标题/URL/页码)样式丑、位置不受控；改走服务端 Puppeteer PDF 后彻底消失，
 * 页头/页脚改成我们自己画：页头公司名旁放「Printed: 时间戳」(替换掉原来的公司地址)，
 * 页脚由 renderHtmlToPdf() 统一加"筛选摘要 - Page X/Y"。
 */
import { docBadge, type DocKind } from './doc-badge'
import { formatPrintTimestamp } from './trip-common'
import { eur } from '@/lib/format-money'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import { computeOrderTotals } from '@/lib/order-totals'
import type { Order } from '@/lib/types'

export type PrintMode = 'day' | 'multiline' | 'summary'

export interface ReportLine {
  date: string
  customerId: string
  customerName: string
  productName: string
  qty: number
  unitPrice: number
  amount: number
  taxRate: number
  orderCode: string
  deliveryBatch: string
  /** 商品目录/仓库拣货顺序号，勾选「按 sequence 排序」时用来排序；查不到的商品兜底 0 排最前 */
  productSequence: number
}

const COMPANY = 'JohnstoneBros'
const COMPANY_COLOR = '#1a3a2a'

export const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; margin: 0 auto; padding: 12mm 12mm 20mm; }

.header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6mm; padding-bottom:3mm; border-bottom:2px solid ${COMPANY_COLOR}; }
.co-name { font-size:22pt; font-weight:bold; font-style:italic; color:${COMPANY_COLOR}; }
.printed-at { text-align:right; font-size:8pt; color:#555; line-height:1.6; }

.report-title { font-size:13pt; font-weight:bold; color:#333; margin-bottom:2mm; }
.report-meta  { font-size:8pt; color:#777; margin-bottom:5mm; }

table { width:100%; border-collapse:collapse; }
th { background:${COMPANY_COLOR}; color:#fff; font-size:8pt; text-transform:uppercase; padding:2.5mm 3mm; text-align:left; }
th.r, td.r { text-align:right; }
th.c, td.c { text-align:center; }

tr.date-row td { background:#e8f0ec; font-weight:bold; font-size:9.5pt; padding:2mm 3mm; color:${COMPANY_COLOR}; }
tr.cust-row td { background:#f4f8f5; font-weight:600; font-size:9pt; padding:1.5mm 3mm 1.5mm 6mm; color:#2d5a40; }
tr.line-row td { padding:1.5mm 3mm 1.5mm 10mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.date-total td { background:#d4e8da; font-weight:bold; font-size:9pt; padding:2mm 3mm; }
tr.grand-total td { background:#1a3a2a; color:#fff; font-weight:bold; font-size:10pt; padding:2.5mm 3mm; }

tr.flat-row td { padding:2mm 3mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.flat-row:nth-child(even) td { background:#f9f9f9; }

tr.sum-row td { padding:2mm 3mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.sum-row:nth-child(even) td { background:#f9f9f9; }

/* 商品×星期汇总:固定列宽(配合 colgroup)确保表头与表体严格对齐 + 完整网格线 */
table.grid { table-layout:fixed; }
table.grid th, table.grid td { border:1px solid #cfcfcf; word-wrap:break-word; overflow-wrap:break-word; }
table.grid th { border-color:#2f5a44; }

tr.order-row td { padding:2mm 3mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.order-row:nth-child(even) td { background:#f9f9f9; }

@media print {
  body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
}
`

export function dayLabel(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' })
}
export function dayOfWeek(dateStr: string): number {
  const d = new Date(dateStr)
  const day = d.getUTCDay()
  return day === 0 ? 6 : day - 1 // Mon=0 ... Sun=6
}
export const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

function formatDateOnly(dateStr: string): string {
  const [y, m, d] = dateStr.split('-')
  return `${d}/${m}/${y}`
}

// ─── Print mode: Order Summary (Odoo "Print") ──────────────────────────────
// Shows: Sale No. | Customer | Driver | Amount | Total VAT
export function buildOrderSummaryHtml(lines: ReportLine[], orders: Order[], title: string, meta: string): string {
  const orderMap = new Map<string, {
    code: string
    customerName: string
    driver: string
    untaxed: number
    tax: number
    total: number
  }>()

  for (const order of orders) {
    const code = order.code ?? order.id.slice(0, 8)
    const driver = formatDriverSlotFromOrder(order) || '—'
    const { untaxed, tax, total } = computeOrderTotals(order)

    orderMap.set(order.id, {
      code,
      customerName: order.restaurantName,
      driver,
      untaxed,
      tax,
      total,
    })
  }

  let grandUntaxed = 0
  let grandTax = 0
  let grandTotal = 0

  const sorted = Array.from(orderMap.values()).sort((a, b) => a.code.localeCompare(b.code))

  const rows = sorted.map(o => {
    grandUntaxed += o.untaxed
    grandTax += o.tax
    grandTotal += o.total
    return `<tr class="order-row">
      <td>${o.code}</td>
      <td>${o.customerName}</td>
      <td>${o.driver}</td>
      <td class="r">${eur(o.untaxed)}</td>
      <td class="r">${eur(o.tax)}</td>
      <td class="r">${eur(o.total)}</td>
    </tr>`
  }).join('')

  return wrapHtml(title, meta, `
    <table>
      <thead><tr>
        <th>Sale No.</th><th>Customer</th><th>Driver</th>
        <th class="r">Untaxed Amount</th><th class="r">Total VAT</th><th class="r">Total</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="grand-total">
          <td colspan="3">Grand Total (${sorted.length} orders)</td>
          <td class="r">${eur(grandUntaxed)}</td>
          <td class="r">${eur(grandTax)}</td>
          <td class="r">${eur(grandTotal)}</td>
        </tr>
      </tbody>
    </table>`)
}

// ─── Multiline mode: flat table ─────────────────────────────────────────────
export function buildMultilineHtml(lines: ReportLine[], title: string, meta: string, sortBySequence: boolean): string {
  const sorted = [...lines].sort((a, b) => sortBySequence
    ? (a.productSequence - b.productSequence) || a.date.localeCompare(b.date)
    : a.date.localeCompare(b.date) || a.customerName.localeCompare(b.customerName))
  let grand = 0
  const rows = sorted.map(l => {
    grand += l.amount
    return `<tr class="flat-row">
      <td>${formatDateOnly(l.date)}</td>
      <td>${l.customerName}</td>
      <td>${l.productName}</td>
      <td class="r">${l.qty.toFixed(2)}</td>
      <td class="r">${eur(l.unitPrice)}</td>
      <td class="r">${eur(l.amount)}</td>
    </tr>`
  }).join('')

  return wrapHtml(title, meta, `
    <table>
      <thead><tr>
        <th>Date</th><th>Customer</th><th>Product</th>
        <th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Amount</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="grand-total">
          <td colspan="5">Grand Total</td>
          <td class="r">${eur(grand)}</td>
        </tr>
      </tbody>
    </table>`)
}

// ─── Summary mode: Product × Day-of-Week (Mon-Sun) like Odoo ────────────────
export function buildSummaryHtml(lines: ReportLine[], title: string, meta: string, sortBySequence: boolean): string {
  // Group by product → accumulate qty per day-of-week（金额列已按需求移除，按总数量降序排）
  const prodMap = new Map<string, { dayQty: number[]; totalQty: number; sequence: number }>()

  for (const l of lines) {
    const dow = dayOfWeek(l.date)
    let entry = prodMap.get(l.productName)
    if (!entry) {
      entry = { dayQty: [0, 0, 0, 0, 0, 0, 0], totalQty: 0, sequence: l.productSequence }
      prodMap.set(l.productName, entry)
    }
    entry.dayQty[dow] += l.qty
    entry.totalQty += l.qty
  }

  // 默认按商品名字母顺序 A→Z；勾选「按 sequence 排序」则按目录/拣货顺序
  const sorted = Array.from(prodMap.entries()).sort((a, b) => sortBySequence
    ? a[1].sequence - b[1].sequence
    : a[0].localeCompare(b[0], 'en'))

  let grandQty = 0
  const grandDayQty = [0, 0, 0, 0, 0, 0, 0]

  const rows = sorted.map(([name, { dayQty, totalQty }]) => {
    grandQty += totalQty
    for (let i = 0; i < 7; i++) grandDayQty[i] += dayQty[i]

    const dayCells = dayQty.map(q => `<td class="r">${q > 0 ? q.toFixed(2) : ''}</td>`).join('')
    return `<tr class="sum-row">
      <td>${name}</td>
      ${dayCells}
      <td class="r" style="font-weight:bold">${totalQty.toFixed(2)}</td>
    </tr>`
  }).join('')

  const grandDayCells = grandDayQty.map(q => `<td class="r">${q > 0 ? q.toFixed(2) : ''}</td>`).join('')
  const dayHeaders = DAY_NAMES.map(d => `<th class="r">${d}</th>`).join('')

  return wrapHtml(title, meta, `
    <table class="grid">
      <colgroup>
        <col style="width:22%" />
        <col span="7" style="width:9%" />
        <col style="width:15%" />
      </colgroup>
      <thead><tr>
        <th>Product</th>
        ${dayHeaders}
        <th class="r">Total Qty</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="grand-total">
          <td>Grand Total</td>
          ${grandDayCells}
          <td class="r">${grandQty.toFixed(2)}</td>
        </tr>
      </tbody>
    </table>`)
}

export function wrapHtml(title: string, meta: string, body: string): string {
  const badgeKind: DocKind = title.includes('Multi Line') ? 'reportMultiline'
    : title.includes('Sale Summary') ? 'reportSummary'
    : 'reportDay'
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <div style="margin-bottom:3mm;">${docBadge(badgeKind)}</div>
  <div class="header">
    <div class="co-name">${COMPANY}</div>
    <div class="printed-at">Printed: ${formatPrintTimestamp()}</div>
  </div>
  <div class="report-title">${title}</div>
  <div class="report-meta">${meta}</div>
  ${body}
</div>
</body>
</html>`
}
