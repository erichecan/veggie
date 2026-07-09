/**
 * Trip Sales Order Print — per-order invoice pages (delivery 模板的姊妹版,带价格)
 *
 * 与送货单(trip-delivery-template.ts)共用同一套页面结构/CSS,区别只在于:
 *   Line items table: QTY | UNIT | DESCRIPTION | PRICE | VAT | INCL VAT
 *   页脚多一个 Totals: Subtotal + VAT breakdown + Total
 * 每单一页(pageBreakAfter),有几个客户就打几页,与送货单一一对应。
 *
 * 税额口径(SSOT,见 docs/20260701 审计 + lib/order-items.ts orderIncTaxTotal):
 *   TripLine.subtotal 恒 = unitPrice × orderedQty,已经是税前金额,直接使用不需要再除税；
 *   含税 = subtotal × (1 + taxRate/100)。taxRate 存的是百分数(如 23,不是 0.23)。
 */

import { barcodeValue } from '@/lib/barcode'
import {
  type TripPrintData,
  type TripOrder,
  type TripCustomer,
  escapeHtml,
} from './trip-common'
import { docBadge } from './doc-badge'

function fmtDateUK(v?: string | Date | null): string {
  if (!v) return '—'
  const d = new Date(v as string)
  if (Number.isNaN(d.getTime())) return '—'
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`
}

function eur(v: number): string {
  return Number.isFinite(v) ? v.toFixed(2) : '0.00'
}

function buildSalesOrderHtml(
  order: TripOrder,
  customer: TripCustomer | undefined,
  teamStr: string,
  opts: { pageBreakAfter?: boolean } = {},
): string {
  const lines = order.lines ?? []

  const orderCode = order.code ?? order.id.slice(-8).toUpperCase()
  const safeCode = orderCode.replace(/['"\\]/g, '')

  const customerAddr = customer
    ? [customer.street, customer.street2, customer.city, customer.zip].filter(Boolean).join(', ')
    : ''

  const customerPhone = customer?.phone ?? order.internalNote ?? ''
  const deliveryDate = fmtDateUK(order.deliveryDate)

  // 税前小计 subtotal 直接用(unitPrice×qty,SSOT 口径),按税率分组算 VAT
  const vatGroups: Record<string, { base: number; vat: number }> = {}
  for (const l of lines) {
    const rate = Number(l.taxRate ?? 0)
    const key = rate.toFixed(2)
    const base = Number(l.subtotal)
    const vatAmt = base * (rate / 100)
    if (!vatGroups[key]) vatGroups[key] = { base: 0, vat: 0 }
    vatGroups[key].base += base
    vatGroups[key].vat += vatAmt
  }
  const subtotal = lines.reduce((s, l) => s + Number(l.subtotal), 0)
  const totalVat = Object.values(vatGroups).reduce((s, g) => s + g.vat, 0)
  const total = subtotal + totalVat

  const paymentTerm = customer?.paymentTerm ?? ''
  const paymentLabel = paymentTerm === 'cash' ? 'Immediate Payment' : paymentTerm === 'weekly' ? 'Weekly' : paymentTerm === 'monthly' ? 'Monthly' : ''
  const isImmediatePayment = paymentTerm === 'cash'
  const paymentColor = isImmediatePayment ? '#dc2626' : '#15803d'
  const paymentBg = isImmediatePayment ? '#fef2f2' : '#f0fdf4'
  const paymentBorder = isImmediatePayment ? '#ef4444' : '#16a34a'

  const linesHtml = lines.map((l, i) => {
    const rate = Number(l.taxRate ?? 0)
    const inclVat = Number(l.subtotal) * (1 + rate / 100)
    return `
    <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td class="col-qty">${Number(l.orderedQty).toFixed(2)}</td>
      <td class="col-unit">${escapeHtml((l.uomName ?? '').toUpperCase())}</td>
      <td class="col-desc">
        <div class="prod-name">${escapeHtml(l.productName)}</div>
        ${l.spec ? `<div class="prod-spec">${escapeHtml(l.spec)}</div>` : ''}
        ${l.note ? `<div class="prod-note">${escapeHtml(l.note)}</div>` : ''}
      </td>
      <td class="col-price">${eur(Number(l.unitPrice))}</td>
      <td class="col-vat">${rate > 0 ? rate.toFixed(0) + '%' : '0%'}</td>
      <td class="col-incl">€ ${eur(inclVat)}</td>
    </tr>`
  }).join('')

  const vatRowsHtml = Object.entries(vatGroups)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([rate, { base, vat }]) => `
    <tr>
      <td class="total-label">VAT ${parseFloat(rate).toFixed(2)}% on € ${eur(base)}</td>
      <td class="total-value">€ ${eur(vat)}</td>
    </tr>`).join('')

  const pageBreak = opts.pageBreakAfter ? 'page-break-after: always;' : ''

  return `
<div class="page" style="${pageBreak}">
  <div class="header">
    <div>
      ${docBadge('salesOrder')}
      <div class="company-name" style="margin-top:2mm;">JohnstoneBros</div>
    </div>
    <div class="company-addr">
      141 Slaney Close<br/>
      Dublin 11, D11 C3NX<br/>
      Ireland
    </div>
  </div>

  <table class="info-table">
    <tr>
      <td>
        <div class="info-head">Customer</div>
        <div class="info-val">
          <strong>${escapeHtml(order.customerName)}</strong><br/>
          ${customerAddr ? escapeHtml(customerAddr) + '<br/>' : ''}
          ${teamStr ? '<strong>Driver:</strong> ' + escapeHtml(teamStr) : ''}
        </div>
      </td>
      <td class="barcode-cell">
        <div class="info-head">Sale Order NO</div>
        <svg id="bc-${safeCode}" class="barcode-svg"></svg>
        <div class="barcode-code">${escapeHtml(orderCode)}</div>
      </td>
      <td>
        <div class="info-head">Delivery</div>
        <div class="info-val">
          ${deliveryDate}<br/>
        </div>
      </td>
      <td>
        <div class="info-head">Payment</div>
        <div class="info-val">
          ${paymentLabel ? `<div style="font-weight:bold;color:${paymentColor};font-size:9.5pt;">${paymentLabel}</div>` : '<div style="color:#999;">—</div>'}
          ${customerPhone ? `<div style="margin-top:2mm;font-size:8.5pt;color:#555;">${escapeHtml(customerPhone)}</div>` : ''}
        </div>
      </td>
    </tr>
  </table>

  <table class="lines-table">
    <thead>
      <tr>
        <th class="col-qty">QTY</th>
        <th class="col-unit">UNIT</th>
        <th class="col-desc">DESCRIPTION</th>
        <th class="col-price">PRICE</th>
        <th class="col-vat">VAT</th>
        <th class="col-incl">INCL VAT</th>
      </tr>
    </thead>
    <tbody>
      ${linesHtml || `<tr><td colspan="6" style="text-align:center;padding:6mm;color:#999">No items</td></tr>`}
    </tbody>
  </table>

  <div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">€ ${eur(subtotal)}</td>
      </tr>
      ${vatRowsHtml}
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">€ ${eur(total)}</td>
      </tr>
    </table>
  </div>

  ${paymentLabel ? `<div style="margin-bottom:6mm;padding:8px 14px;border-radius:6px;border:2px solid ${paymentBorder};background:${paymentBg};display:inline-block;">
    <span style="font-size:12pt;font-weight:700;color:${paymentColor};letter-spacing:0.3px;">PAYMENT: ${paymentLabel}</span>
  </div>` : ''}

  ${customer?.externalNote ? `<div class="note-box">
    <div class="note-head">客户备注 / Customer Note</div>
    <div class="note-body">${escapeHtml(customer.externalNote)}</div>
  </div>` : ''}
  ${order.externalNote ? `<div class="note-box">
    <div class="note-head">订单备注 / Order Note</div>
    <div class="note-body">${escapeHtml(order.externalNote)}</div>
  </div>` : ''}
</div>`
}

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 22mm; position: relative; }

.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 7mm; padding-bottom: 3mm; border-bottom: 2px solid #1a3a2a; }
.company-name { font-size: 26pt; font-weight: bold; font-style: italic; color: #1a3a2a; }
.company-addr { text-align: right; font-size: 8.5pt; color: #444; line-height: 1.6; }

.info-table { width: 100%; border-collapse: collapse; margin-bottom: 7mm; }
.info-table td { border: 1px solid #bbb; padding: 3mm 4mm; vertical-align: top; width: 25%; }
.info-head { font-size: 7pt; font-weight: bold; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; }
.info-val  { font-size: 9pt; color: #111; line-height: 1.6; }
.barcode-cell { text-align: center; }
.barcode-svg { max-width: 100%; height: 22mm; display: block; margin: 0 auto; }
.barcode-code { font-size: 9pt; font-weight: bold; margin-top: 1mm; letter-spacing: 1px; }

.lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
.lines-table thead tr { background: #1a3a2a; color: #fff; }
.lines-table thead th { padding: 2.5mm 3mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
.lines-table tbody tr.row-even { background: #fff; }
.lines-table tbody tr.row-odd  { background: #f7f7f7; }
.lines-table tbody td { padding: 2mm 3mm; font-size: 9pt; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

.col-qty   { text-align: right; width: 9%; }
.col-unit  { text-align: left;  width: 8%; }
.col-desc  { text-align: left;  width: 37%; }
.col-price { text-align: right; width: 12%; }
.col-vat   { text-align: center; width: 7%; }
.col-incl  { text-align: right; width: 13%; }

.prod-name { font-weight: normal; }
.prod-spec { color: #666; font-size: 8pt; margin-top: 1px; }
.prod-note { color: #b45309; font-size: 8pt; font-style: italic; margin-top: 1px; }

.note-box { margin-top: 4mm; padding: 2.5mm 4mm; background: #f9fafb; border: 1px solid #e5e7eb; border-radius: 4px; }
.note-head { font-size: 8pt; font-weight: bold; color: #374151; margin-bottom: 1mm; }
.note-body { font-size: 9pt; color: #111; line-height: 1.5; white-space: pre-wrap; }

.totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
.totals-table { width: 260px; border-collapse: collapse; border: 1px solid #ccc; }
.totals-table tr td { padding: 2mm 4mm; font-size: 9.5pt; border-bottom: 1px solid #e0e0e0; }
.total-label { color: #555; }
.total-value { text-align: right; }
.total-grand td { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; border-bottom: none; }

.footer-fixed {
  position: fixed;
  bottom: 0; left: 0; right: 0;
  padding: 2mm 12mm 4mm;
  background: #fff;
}
.footer-divider { border: none; border-top: 1px solid #ccc; margin-bottom: 2mm; }
.footer-lines { font-size: 7.5pt; color: #666; line-height: 1.6; }
.footer-page-row { display: flex; justify-content: space-between; font-size: 7.5pt; color: #666; margin-top: 1mm; }

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 8mm 12mm 22mm; }
  .footer-fixed { position: fixed; bottom: 0; }
}
`

export function generateTripSalesHtml(data: TripPrintData): string {
  const { trip, orders, customers } = data

  const teamParts = [
    trip.timeSlot?.toLowerCase() ?? '',
    trip.name ?? '',
    trip.driverName ?? '',
  ].filter(Boolean)
  const teamStr = teamParts.join(' ')

  const totalPages = orders.length
  const pagesHtml = orders.map((order, idx) => {
    const customer = customers.get(order.customerId)
    return buildSalesOrderHtml(order, customer, teamStr, {
      pageBreakAfter: idx < totalPages - 1,
    })
  }).join('')

  const barcodeInits = orders.map(order => {
    const orderCode = order.code ?? order.id.slice(-8).toUpperCase()
    const safeCode = orderCode.replace(/['"\\]/g, '')
    return `
    try {
      JsBarcode('#bc-${safeCode}', ${JSON.stringify(barcodeValue(orderCode, order.id))}, {
        format: 'CODE128',
        width: 1.5,
        height: 45,
        displayValue: false,
        margin: 0,
      });
    } catch(e) { console.warn('Barcode error for ${safeCode}:', e); }`
  }).join('\n')

  const noticeHtml = trip.notice
    ? `<div style="background:#fef3c7;border:1px solid #f59e0b;color:#92400e;padding:3mm 5mm;margin:0 auto 5mm;max-width:210mm;font-size:9pt;font-weight:bold;">⚠ ${escapeHtml(trip.notice)}</div>`
    : ''

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>Sales Orders</title>
<script src="/vendor/JsBarcode.all.min.js"><\/script>
<style>${CSS}</style>
</head>
<body>
${noticeHtml}
${pagesHtml}

<div class="footer-fixed">
  <hr class="footer-divider"/>
  <div class="footer-lines">
    Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;&nbsp; Mail: info@johnstonebros.ie | johnstoneveg@gmail.com<br/>
    Web: https://m.johnstonebros.ie/ &nbsp;&nbsp; VAT: IE9739451J
  </div>
  <div class="footer-page-row">
    <span>Page: 1 / ${totalPages}</span>
    <span>Print at: <span id="print-ts"></span></span>
  </div>
</div>

<script>
  ${barcodeInits}
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  document.getElementById('print-ts').textContent =
    ts.getFullYear() + '-' + pad(ts.getMonth()+1) + '-' + pad(ts.getDate()) +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
  window.print();
<\/script>
</body>
</html>`
}
