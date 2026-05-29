/**
 * Trip 送货汇总单 — 单页汇总表，每行一个订单
 *
 * 列：Sale No. | Customer | Team | Amount | Total VAT
 * 底部：Total 行 + 客户数
 */

import {
  type TripPrintData,
  escapeHtml,
} from './trip-common'

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
    for (const l of o.lines) {
      vat += l.subtotal * normalizeRate(l.taxRate)
    }
    return { order: o, vat }
  })

  const uniqueCustomers = new Set(orders.map(o => o.customerId)).size
  const totalVat = orderRows.reduce((s, r) => s + r.vat, 0)

  const rowsHtml = orderRows.map(({ order: o, vat }) => `
    <tr>
      <td>${escapeHtml(o.code ?? o.id.slice(0, 8).toUpperCase())}</td>
      <td>${escapeHtml(o.customerName)}</td>
      <td>${escapeHtml(teamStr)}</td>
      <td class="num">${fmtAmt(o.totalAmount)}</td>
      <td class="num">${fmtAmt(vat)}</td>
    </tr>
  `).join('')

  const now = fmtTimestamp(new Date().toISOString())

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Summary</title>
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
  table.summary td {
    border: 1px solid #999;
    padding: 3px 8px;
    vertical-align: top;
  }
  table.summary td.num { text-align: right; }
  table.summary tr.total-row td {
    font-weight: 700;
    border-top: 2px solid #000;
  }

  @media print {
    body { padding: 0; }
    @page { margin: 12mm 10mm; }
  }
</style>
</head>
<body>
  <div class="page-header">
    <div class="left">${now}</div>
    <div class="center">Johnstone Fruit &amp; Veg Ltd</div>
    <div class="right">1 / 1</div>
  </div>

  <div class="filter-row">
    <div class="item"><span class="label">Start Date : </span>${fmtDateUK(startDate)}</div>
    <div class="item"><span class="label">End Date : </span>${fmtDateUK(endDate)}</div>
    <div class="item"><span class="label">Sales Team : </span>${escapeHtml(teamStr)}</div>
    <div class="item"><span class="label">Salesman : </span></div>
  </div>

  <table class="summary">
    <thead>
      <tr>
        <th>Sale No.</th>
        <th>Customer</th>
        <th>Team</th>
        <th class="num">Amount</th>
        <th class="num">Total VAT</th>
      </tr>
    </thead>
    <tbody>
      ${rowsHtml || '<tr><td colspan="5" style="text-align:center;color:#999;padding:20px">No orders</td></tr>'}
      <tr class="total-row">
        <td>Total</td>
        <td>No of Customer : ${uniqueCustomers}</td>
        <td></td>
        <td class="num"></td>
        <td class="num">${fmtAmt(totalVat)}</td>
      </tr>
    </tbody>
  </table>

<script>window.print();<\/script>
</body>
</html>`
}
