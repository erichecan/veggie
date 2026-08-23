/**
 * Trip Sales Order Print — per-order invoice pages (delivery 模板的姊妹版,带价格)
 *
 * 与送货单(trip-delivery-template.ts)共用同一套页面结构/CSS,区别只在于:
 *   Line items table: QTY | UNIT | DESCRIPTION | PRICE | VAT | INCL VAT
 *   多一个 Totals: Subtotal + VAT breakdown + Total
 * 每单一页(pageBreakAfter),有几个客户就打几页,与送货单一一对应。
 *
 * 税额口径(SSOT,见 docs/20260701 审计 + lib/order-items.ts orderIncTaxTotal):
 *   TripLine.subtotal 恒 = unitPrice × orderedQty,已经是税前金额,直接使用不需要再除税；
 *   含税 = subtotal × (1 + taxRate/100)。taxRate 存的是百分数(如 23,不是 0.23)。
 *
 * 单个订单的明细如果多到一页放不下,按 chunkOrderLinesForPrint 手动分块,每块单独
 * 渲染成一个 .page、页头在每块顶部都重新画一次(客户反馈,20260716)——试过把页头
 * 塞进 <thead> 让浏览器自动跨页重复,无头 Chromium 的 page.pdf() 实测不支持,详见
 * chunkOrderLinesForPrint 的注释。Totals/Payment/备注只出现在订单的最后一块。
 * 没有联系方式页脚——客户明确要求不要(20260716)；每页底部只有一行订单号-页码
 * (20260718 新要求)，方便一叠纸打乱后还能按页脚归位。
 */

import { barcodeValue } from '@/lib/barcode'
import {
  type TripPrintData,
  type TripOrder,
  type TripCustomer,
  type TripLine,
  escapeHtml,
  formatTripDriverLabel,
  chunkOrderLinesForPrint,
  renderPageNumberFooter,
  renderTripNoticeHtml,
  PRINT_PAGE_FOOTER_CSS,
} from './trip-common'
import { sortLinesBySequence } from '@/lib/print/line-sort'
import { docBadge } from './doc-badge'
import { formatDateOnly } from '@/lib/format-date'
import { fmtMoney } from '@/lib/format-money'
import { displayUomName } from '@/lib/sale-uom'
import { formatUomConversionHint } from '@/lib/print/uom-conversion'

function buildSalesOrderHtml(
  order: TripOrder,
  customer: TripCustomer | undefined,
  driverLabel: string,
  opts: { pageBreakAfter?: boolean } = {},
): string {
  // 按商品 sequence 排（客户要求 2026-08-18），与销售单/发票 PDF 同一口径
  const lines = sortLinesBySequence<TripLine>(order.lines ?? [])

  const orderCode = order.code ?? order.id.slice(-8).toUpperCase()
  const safeCode = orderCode.replace(/['"\\]/g, '')

  const customerAddr = customer
    ? [customer.street, customer.street2, customer.city, customer.zip].filter(Boolean).join(', ')
    : ''

  const customerPhone = customer?.phone ?? order.internalNote ?? ''
  const deliveryDate = formatDateOnly(order.deliveryDate)

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

  function renderLineRow(l: TripLine, i: number): string {
    const rate = Number(l.taxRate ?? 0)
    const inclVat = Number(l.subtotal) * (1 + rate / 100)
    const uomHint = formatUomConversionHint(l.uomConversion ?? undefined, Number(l.orderedQty))
    return `
    <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td class="col-qty">${Number(l.orderedQty).toFixed(2)}</td>
      <td class="col-unit">${escapeHtml(displayUomName(l.uomName).toUpperCase())}</td>
      <td class="col-desc">
        <div class="prod-name">${escapeHtml(l.productName)}</div>
        ${l.spec ? `<div class="prod-spec">${escapeHtml(l.spec)}</div>` : ''}
        ${uomHint ? `<div class="prod-spec">${escapeHtml(uomHint.conversionLine)}${uomHint.weightLine ? ` (${escapeHtml(uomHint.weightLine)})` : ''}</div>` : ''}
        ${l.note ? `<div class="prod-note">${escapeHtml(l.note)}</div>` : ''}
      </td>
      <td class="col-price">${fmtMoney(Number(l.unitPrice))}</td>
      <td class="col-vat">${rate > 0 ? rate.toFixed(0) + '%' : '0%'}</td>
      <td class="col-incl">€ ${fmtMoney(inclVat)}</td>
    </tr>`
  }

  const vatRowsHtml = Object.entries(vatGroups)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([rate, { base, vat }]) => `
    <tr>
      <td class="total-label">VAT ${parseFloat(rate).toFixed(2)}% on € ${fmtMoney(base)}</td>
      <td class="total-value">€ ${fmtMoney(vat)}</td>
    </tr>`).join('')

  const headerBlockHtml = `
  <div class="header">
    <div>
      ${docBadge('salesOrder')}
      <div class="company-name" style="margin-top:2mm;">JohnstoneBros</div>
    </div>
    <div class="company-addr">
      141 Slaney Close<br/>
      Dublin 11, D11 C3NX
    </div>
  </div>

  <table class="info-table">
    <tr>
      <td>
        <div class="info-head">Customer</div>
        <div class="info-val">
          <strong>${escapeHtml(order.customerName)}</strong><br/>
          ${customerAddr ? escapeHtml(customerAddr) + '<br/>' : ''}
          ${driverLabel ? '<strong>Driver:</strong> ' + escapeHtml(driverLabel) : ''}
        </div>
      </td>
      <td class="barcode-cell">
        <div class="info-head">Sale Order NO</div>
        <svg class="barcode-svg bc-${safeCode}"></svg>
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
  </table>`

  const footerBlockHtml = `
  <div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">€ ${fmtMoney(subtotal)}</td>
      </tr>
      ${vatRowsHtml}
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">€ ${fmtMoney(total)}</td>
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
  </div>` : ''}`

  // Totals/Payment/备注只画在最后一块，但那块要放的东西比其它块多得多(实测 25 行长订单
  // 会撑到 301mm，溢出成 2 张物理纸)——分块时必须把这块「额外内容」也当成预留高度算进去，
  // 不然最后一块自己就会溢出单页，页脚跟着错位到下一张纸,失去"一页一页脚"的准确性。
  // 预留按常见情况估(1个税率档+付款徽章)，宁可多分一页也不能真溢出。
  const LAST_CHUNK_EXTRA_MM = 63
  // LAST_CHUNK_EXTRA_MM 只压最后一页，不该让每一页都为它让地方（见 chunkOrderLinesForPrint）
  const chunks = chunkOrderLinesForPrint(lines, undefined, LAST_CHUNK_EXTRA_MM)

  return chunks.map((chunk, chunkIdx) => {
    const isLastChunk = chunkIdx === chunks.length - 1
    const pageBreak = (!isLastChunk || opts.pageBreakAfter) ? 'page-break-after: always;' : ''
    const linesHtml = chunk.map(renderLineRow).join('')
    return `
<div class="page" style="${pageBreak}">
  ${headerBlockHtml}

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
      ${linesHtml || (isLastChunk ? `<tr><td colspan="6" style="text-align:center;padding:6mm;color:#999">No items</td></tr>` : '')}
    </tbody>
  </table>

  ${isLastChunk ? footerBlockHtml : ''}
  ${renderPageNumberFooter(orderCode, chunkIdx + 1, chunks.length)}
</div>`
  }).join('')
}

const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, "Noto Sans CJK SC", "Noto Sans SC", sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm; position: relative; }

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
.lines-table thead th { padding: 1.6mm 2.5mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
.lines-table tbody tr.row-even { background: #fff; }
.lines-table tbody tr.row-odd  { background: #f7f7f7; }
/* 行高与 lib/order-pdf.ts、print/[id] 同一口径（客户要求一页至少 20 行，2026-08-18）。
   ⚠️ 这个模板是手工预估分页的，改行高必须同步 lib/print/trip-common.ts 的
   PRINT_ROW_BASE_MM，预估小于实际会真的溢出物理页。改完跑
   scripts/print/measure-print-page.ts 核对。 */
.lines-table tbody td { padding: 1.1mm 2.5mm; font-size: 8.5pt; line-height: 1.25; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

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

${PRINT_PAGE_FOOTER_CSS}

@media print {
  body { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  .page { padding: 8mm 12mm; }
  /* .page 已经用 min-height:297mm 模拟一整张 A4，浏览器打印对话框自带的默认页边距会叠加在
     这 297mm 之上，导致内容溢出单页、多挤出一张几乎空白的续页——把 @page margin 清零，
     视觉边距完全交给 .page 自身的 padding 负责。 */
  @page { size: A4; margin: 0; }
}
`

export function generateTripSalesHtml(data: TripPrintData): string {
  const { trip, orders, customers } = data

  // 筛选打印/全部打印可能横跨多个司机,trip 级标签会是空的——每单优先用自己实际所属的
  // 批次(driverBatchLabel),查不到才退回 trip 级(单批次打印时两者本就一致)。
  const tripDriverLabel = formatTripDriverLabel(trip)

  const pagesHtml = orders.map((order, idx) => {
    const customer = customers.get(order.customerId)
    return buildSalesOrderHtml(order, customer, order.driverBatchLabel || tripDriverLabel, {
      pageBreakAfter: idx < orders.length - 1,
    })
  }).join('')

  const barcodeInits = orders.map(order => {
    const orderCode = order.code ?? order.id.slice(-8).toUpperCase()
    const safeCode = orderCode.replace(/['"\\]/g, '')
    // 长订单被 chunkOrderLinesForPrint 拆成多页时,每页都重画一次页头,同一订单的
    // 条码 svg 会出现多份——用 class 选择器一次性渲染到所有份(JsBarcode 支持
    // 传入匹配多个元素的选择器),不能用 id(同一订单多份页头会产生重复 id)。
    return `
    try {
      JsBarcode('.bc-${safeCode}', ${JSON.stringify(barcodeValue(orderCode, order.id))}, {
        format: 'CODE128',
        width: 1.5,
        height: 45,
        displayValue: false,
        margin: 0,
      });
    } catch(e) { console.warn('Barcode error for ${safeCode}:', e); }`
  }).join('\n')

  const noticeHtml = renderTripNoticeHtml(trip.notice)

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

<script>
  ${barcodeInits}
  window.print();
<\/script>
</body>
</html>`
}
