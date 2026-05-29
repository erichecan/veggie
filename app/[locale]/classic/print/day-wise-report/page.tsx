'use client'
import { useEffect, useState, Suspense } from 'react'
import { useSearchParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import type { Order } from '@/lib/types'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'

type PrintMode = 'day' | 'multiline' | 'summary'

interface ReportLine {
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
}

const COMPANY = 'JohnstoneBros'
const COMPANY_ADDR = '141 Slaney Close, Dublin 11, D11 C3NX, Ireland'
const COMPANY_COLOR = '#1a3a2a'

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; margin: 0 auto; padding: 12mm 12mm 20mm; }

.header { display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:6mm; padding-bottom:3mm; border-bottom:2px solid ${COMPANY_COLOR}; }
.co-name { font-size:22pt; font-weight:bold; font-style:italic; color:${COMPANY_COLOR}; }
.co-addr { text-align:right; font-size:8pt; color:#555; line-height:1.6; }

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

tr.order-row td { padding:2mm 3mm; font-size:9pt; border-bottom:1px solid #eee; }
tr.order-row:nth-child(even) td { background:#f9f9f9; }

@media print {
  body { -webkit-print-color-adjust:exact; print-color-adjust:exact; }
}
`

function eur(n: number) { return `€${n.toFixed(2)}` }
function fmtDate(iso: string) {
  const d = new Date(iso)
  return `${String(d.getDate()).padStart(2,'0')}/${String(d.getMonth()+1).padStart(2,'0')}/${d.getFullYear()}`
}
function dayLabel(dateStr: string) {
  const d = new Date(dateStr)
  return d.toLocaleDateString('en-GB', { weekday:'long', year:'numeric', month:'long', day:'numeric' })
}
function dayOfWeek(dateStr: string): number {
  const d = new Date(dateStr)
  const day = d.getUTCDay()
  return day === 0 ? 6 : day - 1 // Mon=0 ... Sun=6
}
const DAY_NAMES = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun']

// ─── Print mode: Order Summary (Odoo "Print") ──────────────────────────────
// Shows: Sale No. | Customer | Sales Team | Amount | Total VAT
function buildOrderSummaryHtml(lines: ReportLine[], orders: Order[], title: string, meta: string): string {
  const orderMap = new Map<string, {
    code: string
    customerName: string
    salesTeam: string
    untaxed: number
    tax: number
    total: number
  }>()

  for (const order of orders) {
    const code = order.code ?? order.id.slice(0, 8)
    const salesTeam = formatDriverSlotFromOrder(order) || '—'
    let untaxed = 0
    let tax = 0

    const hasLines = order.lines && order.lines.length > 0
    if (hasLines) {
      for (const l of order.lines!) {
        const sub = Number(l.subtotal)
        const rate = Number(l.taxRate ?? 0)
        const normalizedRate = rate > 1 ? rate / 100 : rate
        untaxed += sub
        tax += sub * normalizedRate
      }
    } else {
      for (const it of (order.items ?? [])) {
        const qty = Number(it.quantity ?? 0)
        const price = Number(it.price ?? 0)
        const sub = Number(it.subtotal ?? qty * price)
        const rate = Number(it.taxRate ?? 0)
        const normalizedRate = rate > 1 ? rate / 100 : rate
        untaxed += sub
        tax += sub * normalizedRate
      }
    }

    orderMap.set(order.id, {
      code,
      customerName: order.restaurantName,
      salesTeam,
      untaxed,
      tax,
      total: untaxed + tax,
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
      <td>${o.salesTeam}</td>
      <td class="r">${eur(o.untaxed)}</td>
      <td class="r">${eur(o.tax)}</td>
      <td class="r">${eur(o.total)}</td>
    </tr>`
  }).join('')

  return wrapHtml(title, meta, `
    <table>
      <thead><tr>
        <th>Sale No.</th><th>Customer</th><th>Sales Team</th>
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

// ─── Day mode: hierarchical by date → customer → product ────────────────────
function buildDayHtml(lines: ReportLine[], title: string, meta: string): string {
  const byDate = new Map<string, Map<string, ReportLine[]>>()
  for (const l of lines) {
    if (!byDate.has(l.date)) byDate.set(l.date, new Map())
    const byCust = byDate.get(l.date)!
    if (!byCust.has(l.customerId)) byCust.set(l.customerId, [])
    byCust.get(l.customerId)!.push(l)
  }
  const dates = Array.from(byDate.keys()).sort()

  let grandQty = 0; let grandAmt = 0
  let tbody = ''

  for (const date of dates) {
    const byCust = byDate.get(date)!
    let dateQty = 0; let dateAmt = 0

    tbody += `<tr class="date-row"><td colspan="4">${dayLabel(date)}</td></tr>`

    for (const [, custLines] of byCust) {
      const custName = custLines[0].customerName
      tbody += `<tr class="cust-row"><td colspan="4">${custName}</td></tr>`

      for (const l of custLines) {
        tbody += `<tr class="line-row">
          <td>${l.productName}</td>
          <td class="r">${l.qty.toFixed(3)}</td>
          <td class="r">${eur(l.unitPrice)}</td>
          <td class="r">${eur(l.amount)}</td>
        </tr>`
        dateQty += l.qty; dateAmt += l.amount
        grandQty += l.qty; grandAmt += l.amount
      }
    }

    tbody += `<tr class="date-total">
      <td>Total for ${fmtDate(date)}</td>
      <td class="r">${dateQty.toFixed(3)}</td>
      <td></td>
      <td class="r">${eur(dateAmt)}</td>
    </tr>`
  }

  tbody += `<tr class="grand-total">
    <td>Grand Total</td>
    <td class="r">${grandQty.toFixed(3)}</td>
    <td></td>
    <td class="r">${eur(grandAmt)}</td>
  </tr>`

  return wrapHtml(title, meta, `
    <table>
      <thead><tr>
        <th>Product</th><th class="r">Qty</th><th class="r">Unit Price</th><th class="r">Amount</th>
      </tr></thead>
      <tbody>${tbody}</tbody>
    </table>`)
}

// ─── Multiline mode: flat table ─────────────────────────────────────────────
function buildMultilineHtml(lines: ReportLine[], title: string, meta: string): string {
  const sorted = [...lines].sort((a, b) => a.date.localeCompare(b.date) || a.customerName.localeCompare(b.customerName))
  let grand = 0
  const rows = sorted.map(l => {
    grand += l.amount
    return `<tr class="flat-row">
      <td>${fmtDate(l.date)}</td>
      <td>${l.customerName}</td>
      <td>${l.productName}</td>
      <td class="r">${l.qty.toFixed(3)}</td>
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
function buildSummaryHtml(lines: ReportLine[], title: string, meta: string): string {
  // Group by product → accumulate qty per day-of-week and total amount
  const prodMap = new Map<string, { dayQty: number[]; totalQty: number; totalAmt: number }>()

  for (const l of lines) {
    const dow = dayOfWeek(l.date)
    let entry = prodMap.get(l.productName)
    if (!entry) {
      entry = { dayQty: [0, 0, 0, 0, 0, 0, 0], totalQty: 0, totalAmt: 0 }
      prodMap.set(l.productName, entry)
    }
    entry.dayQty[dow] += l.qty
    entry.totalQty += l.qty
    entry.totalAmt += l.amount
  }

  const sorted = Array.from(prodMap.entries()).sort((a, b) => b[1].totalAmt - a[1].totalAmt)

  let grandQty = 0
  let grandAmt = 0
  const grandDayQty = [0, 0, 0, 0, 0, 0, 0]

  const rows = sorted.map(([name, { dayQty, totalQty, totalAmt }]) => {
    grandQty += totalQty
    grandAmt += totalAmt
    for (let i = 0; i < 7; i++) grandDayQty[i] += dayQty[i]

    const dayCells = dayQty.map(q => `<td class="r">${q > 0 ? q.toFixed(3) : ''}</td>`).join('')
    return `<tr class="sum-row">
      <td>${name}</td>
      ${dayCells}
      <td class="r" style="font-weight:bold">${totalQty.toFixed(3)}</td>
      <td class="r" style="font-weight:bold">${eur(totalAmt)}</td>
    </tr>`
  }).join('')

  const grandDayCells = grandDayQty.map(q => `<td class="r">${q > 0 ? q.toFixed(3) : ''}</td>`).join('')
  const dayHeaders = DAY_NAMES.map(d => `<th class="r">${d}</th>`).join('')

  return wrapHtml(title, meta, `
    <table>
      <thead><tr>
        <th>Product</th>
        ${dayHeaders}
        <th class="r">Total Qty</th>
        <th class="r">Total Amount</th>
      </tr></thead>
      <tbody>
        ${rows}
        <tr class="grand-total">
          <td>Grand Total</td>
          ${grandDayCells}
          <td class="r">${grandQty.toFixed(3)}</td>
          <td class="r">${eur(grandAmt)}</td>
        </tr>
      </tbody>
    </table>`)
}

function wrapHtml(title: string, meta: string, body: string): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<title>${title}</title>
<style>${CSS}</style>
</head>
<body>
<div class="page">
  <div class="header">
    <div class="co-name">${COMPANY}</div>
    <div class="co-addr">${COMPANY_ADDR}</div>
  </div>
  <div class="report-title">${title}</div>
  <div class="report-meta">${meta}</div>
  ${body}
</div>
<script>
  window.print();
<\/script>
</body>
</html>`
}

function DayWiseReportInner() {
  const searchParams = useSearchParams()
  const mode = (searchParams.get('mode') ?? 'day') as PrintMode
  const fromDate = searchParams.get('from') ?? ''
  const toDate = searchParams.get('to') ?? ''
  const customerIds = searchParams.get('customerIds')?.split(',').filter(Boolean) ?? []
  const productNames = searchParams.get('productNames')?.split(',').filter(Boolean) ?? []
  const driverBatch = searchParams.get('driverBatch') ?? ''
  const categoryId = searchParams.get('categoryId') ?? ''
  const salesman = searchParams.get('salesman') ?? ''

  const [html, setHtml] = useState<string>('')
  const [ready, setReady] = useState(false)

  useEffect(() => {
    async function load() {
      try {
        const params = new URLSearchParams({ include_lines: 'true', limit: '5000', dateField: 'deliveryDate' })
        if (fromDate) params.set('fromDate', fromDate)
        if (toDate) params.set('toDate', toDate)
        if (customerIds.length > 0) params.set('restaurantIds', customerIds.join(','))
        if (driverBatch) params.set('deliveryBatch', driverBatch)
        if (categoryId) params.set('categoryId', categoryId)
        if (salesman) params.set('salesman', salesman)

        const orders = await apiGet<Order[]>(`/api/orders?${params}`)

        const lines: ReportLine[] = []
        for (const order of orders) {
          const dateKey = (order as unknown as { deliveryDate?: string }).deliveryDate ?? order.createdAt
          const date = dateKey.slice(0, 10)

          const hasLines = order.lines && order.lines.length > 0
          if (hasLines) {
            for (const l of order.lines!) {
              if (productNames.length > 0 && !productNames.includes(l.productName)) continue
              lines.push({
                date,
                customerId: order.restaurantId,
                customerName: order.restaurantName,
                productName: l.productName,
                qty: Number(l.orderedQty),
                unitPrice: Number(l.unitPrice),
                amount: Number(l.subtotal),
                taxRate: Number(l.taxRate ?? 0),
                orderCode: order.code ?? '',
                deliveryBatch: formatDriverSlotFromOrder(order),
              })
            }
          } else {
            for (const it of (order.items ?? [])) {
              if (!it.productName) continue
              if (productNames.length > 0 && !productNames.includes(it.productName)) continue
              const qty = Number(it.quantity ?? 0)
              const price = Number(it.price ?? 0)
              const subtotal = Number(it.subtotal ?? qty * price)
              lines.push({
                date,
                customerId: order.restaurantId,
                customerName: order.restaurantName,
                productName: it.productName,
                qty,
                unitPrice: price,
                amount: subtotal,
                taxRate: Number(it.taxRate ?? 0),
                orderCode: order.code ?? '',
                deliveryBatch: formatDriverSlotFromOrder(order),
              })
            }
          }
        }

        const dateLabel = fromDate && toDate ? `${fromDate} → ${toDate}` : fromDate || toDate || 'All dates'
        const custLabel = customerIds.length > 0 ? `${customerIds.length} customer(s) selected` : 'All customers'
        const prodLabel = productNames.length > 0 ? `${productNames.length} product(s) selected` : 'All products'
        const batchLabel = driverBatch ? `Batch: ${driverBatch}` : 'All batches'
        const meta = `Period: ${dateLabel}  |  ${custLabel}  |  ${prodLabel}  |  ${batchLabel}  |  ${lines.length} lines`

        const TITLES: Record<PrintMode, string> = {
          day: 'Order Summary Report',
          multiline: 'Product Sales Multi Line Report',
          summary: 'Product Sale Summary Report',
        }

        let result: string
        if (mode === 'multiline') {
          result = buildMultilineHtml(lines, TITLES.multiline, meta)
        } else if (mode === 'summary') {
          result = buildSummaryHtml(lines, TITLES.summary, meta)
        } else {
          result = buildOrderSummaryHtml(lines, orders, TITLES.day, meta)
        }

        setHtml(result)
        setReady(true)
      } catch (e) {
        console.error('Day wise report load failed:', e)
      }
    }
    load()
  }, [mode, fromDate, toDate, customerIds.join(','), productNames.join(','), driverBatch, categoryId, salesman])

  if (!ready) {
    return (
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontFamily:'Arial,sans-serif', color:'#666' }}>
        Loading report…
      </div>
    )
  }

  return <div dangerouslySetInnerHTML={{ __html: html }} style={{ all: 'unset' }} />
}

export default function DayWiseReportPage() {
  return (
    <Suspense fallback={
      <div style={{ display:'flex', alignItems:'center', justifyContent:'center', height:'100vh', fontFamily:'Arial,sans-serif', color:'#666' }}>
        Loading…
      </div>
    }>
      <DayWiseReportInner />
    </Suspense>
  )
}
