/**
 * Trip 汇总单 — 批次级汇总，含条形码
 *
 * 列：条形码 | Sale No. | Customer | Amount | Total VAT
 * 底部：总重量、总金额、客户数
 */

import {
  type TripPrintData,
  escapeHtml,
} from './trip-common'
import { docBadge } from './doc-badge'

function fmtDateUK(v?: string | null): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const dd = String(d.getDate()).padStart(2, '0')
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  return `${dd}/${mm}/${d.getFullYear()}`
}

function fmtTimestamp(v?: string | null): string {
  if (!v) return ''
  const d = new Date(v)
  if (Number.isNaN(d.getTime())) return ''
  const yyyy = d.getFullYear()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${yyyy}-${mm}-${dd} ${hh}:${mi}`
}

function fmtAmt(v: number): string {
  return v.toLocaleString('en-IE', { minimumFractionDigits: 1, maximumFractionDigits: 2 })
}

const normalizeRate = (r: number) => (r > 1 ? r / 100 : r)

export function generateTripSummaryHtml(data: TripPrintData): string {
  const { trip, orders } = data

  const teamParts = [
    trip.timeSlot?.toLowerCase() ?? '',
    trip.name ?? '',
    trip.driverName ?? '',
  ].filter(Boolean)
  const teamStr = teamParts.join(' ')

  const deliveryDates = orders
    .map(o => o.deliveryDate)
    .filter(Boolean) as string[]
  const startDate = deliveryDates.length > 0
    ? deliveryDates.reduce((a, b) => (a < b ? a : b))
    : trip.departTime
  const endDate = deliveryDates.length > 0
    ? deliveryDates.reduce((a, b) => (a > b ? a : b))
    : trip.departTime

  const orderRows = orders.map(o => {
    let vat = 0
    let totalWeight = 0
    for (const l of o.lines) {
      vat += l.subtotal * normalizeRate(l.taxRate)
      totalWeight += l.orderedQty
    }
    return { order: o, vat, totalWeight }
  })

  const uniqueCustomers = new Set(orders.map(o => o.customerId)).size
  const totalVat = orderRows.reduce((s, r) => s + r.vat, 0)
  const totalAmount = orderRows.reduce((s, r) => s + r.order.totalAmount, 0)
  const totalWeight = orderRows.reduce((s, r) => s + r.totalWeight, 0)

  const rowsHtml = orderRows.map(({ order: o, vat }) => {
    const code = o.code ?? o.id.slice(0, 8).toUpperCase()
    const safeCode = code.replace(/['"\\]/g, '')
    return `
    <tr>
      <td class="bc-cell"><svg id="bc-s-${safeCode}" class="bc-svg"></svg></td>
      <td>${escapeHtml(code)}</td>
      <td>${escapeHtml(o.customerName)}</td>
      <td>${escapeHtml(teamStr)}</td>
      <td class="num">${fmtAmt(o.totalAmount)}</td>
      <td class="num">${fmtAmt(vat)}</td>
    </tr>`
  }).join('')

  const barcodeInits = orders.map(o => {
    const code = o.code ?? o.id.slice(0, 8).toUpperCase()
    const safeCode = code.replace(/['"\\]/g, '')
    return `try{JsBarcode('#bc-s-${safeCode}',${JSON.stringify(code)},{format:'CODE128',width:1.2,height:28,displayValue:false,margin:0});}catch(e){}`
  }).join('\n')

  const now = fmtTimestamp(new Date().toISOString())

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Summary</title>
<script src="/vendor/JsBarcode.all.min.js"><\/script>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  html, body { font-family: Arial, Helvetica, sans-serif; font-size: 11px; color: #000; background: #fff; }
  body { padding: 18px 24px; }

  .page-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 10px;
  }
  .page-header .left { font-size: 10px; color: #333; }
  .page-header .center { text-align: center; font-size: 14px; font-weight: 700; }
  .page-header .right { font-size: 10px; color: #333; text-align: right; }

  .filter-row {
    display: flex;
    gap: 24px;
    margin-bottom: 8px;
    font-size: 11px;
    border-bottom: 1px solid #000;
    padding-bottom: 4px;
  }
  .filter-row .item { white-space: nowrap; }
  .filter-row .label { font-weight: 700; }

  table.summary {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    margin-top: 4px;
  }
  table.summary th {
    background: #e8e8e8;
    border: 1px solid #999;
    padding: 4px 8px;
    text-align: left;
    font-weight: 700;
    font-size: 11px;
  }
  table.summary th.num { text-align: right; }
  table.summary th.bc { text-align: center; width: 120px; }
  table.summary td {
    border: 1px solid #999;
    padding: 3px 8px;
    vertical-align: middle;
  }
  table.summary td.num { text-align: right; }
  table.summary td.bc-cell { text-align: center; padding: 2px 4px; }
  table.summary tr.total-row td {
    font-weight: 700;
    border-top: 2px solid #000;
  }

  .bc-svg { max-width: 110px; height: 24px; display: block; margin: 0 auto; }

  .stats-row {
    margin-top: 10px;
    display: flex;
    gap: 24px;
    font-size: 11px;
    padding: 6px 8px;
    background: #f5f5f5;
    border-radius: 3px;
  }
  .stats-row .num { font-weight: 700; }

  @media print {
    body { padding: 0; }
    @page { margin: 12mm 10mm; }
  }
</style>
</head>
<body>
  <div style="margin-bottom:3mm;">${docBadge('deliverySummary')}</div>
  <div class="page-header">
    <div class="left">${now}</div>
    <div class="center">Johnstone Fruit &amp; Veg Ltd — 汇总单</div>
    <div class="right">1 / 1</div>
  </div>

  <div class="filter-row">
    <div class="item"><span class="label">Start Date : </span>${fmtDateUK(startDate)}</div>
    <div class="item"><span class="label">End Date : </span>${fmtDateUK(endDate)}</div>
    <div class="item"><span class="label">Sales Team : </span>${escapeHtml(teamStr)}</div>
  </div>

  <table class="summary">
    <thead>
      <tr>
        <th class="bc">条形码</th>
        <th>Sale No.</th>
        <th>Customer</th>
        <th>Team</th>
        <th class="num">Amount</th>
        <th class="num">Total VAT</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="6" style="text-align:center;color:#999;padding:20px">No orders</td></tr>'}
      <tr class="total-row">
        <td></td>
        <td>Total</td>
        <td>No of Customer : ${uniqueCustomers}</td>
        <td></td>
        <td class="num">${fmtAmt(totalAmount)}</td>
        <td class="num">${fmtAmt(totalVat)}</td>
      </tr>
    </tbody>
  </table>

  <div class="stats-row">
    <span>客户数：<span class="num">${uniqueCustomers}</span></span>
    <span>订单数：<span class="num">${orders.length}</span></span>
    <span>总金额：<span class="num">&euro; ${fmtAmt(totalAmount)}</span></span>
    <span>总 VAT：<span class="num">&euro; ${fmtAmt(totalVat)}</span></span>
  </div>

<script>
  ${barcodeInits}
  window.print();
<\/script>
</body>
</html>`
}
