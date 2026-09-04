'use client'
import { useEffect, useRef, useState } from 'react'
import { useParams } from 'next/navigation'
import { apiGet } from '@/lib/api'
import type { Order, Customer } from '@/lib/types'
import { formatDriverSlotFromOrder } from '@/lib/driver-slot'
import JsBarcode from 'jsbarcode'
import { barcodeValue } from '@/lib/barcode'
import { docBadge } from '@/lib/print/doc-badge'
import { formatDateOnly } from '@/lib/format-date'
import { eur } from '@/lib/format-money'
import { chunkOrderLinesForPrint } from '@/lib/print/trip-common'
import { sortLinesBySequence } from '@/lib/print/line-sort'
import { displayUomName } from '@/lib/sale-uom'

/**
 * 最后一块除了富页脚(联系方式+页码)，还要放 Totals/Payment 徽章(sales/invoice)或最多 3 个
 * 备注框(delivery: 客户/订单/送货备注)——这些内容不算进行高预估，实测长订单会撑破单页
 * 变成 2 张物理纸，页脚跟着错位(同 trip-sales/delivery-template 的教训)。按两种 docType
 * 的最坏情况取更大值，宁可多分一页也不能真溢出。
 *
 * ⚠️ 这是**只有最后一页才有**的开销，作为 chunkOrderLinesForPrint 的第 3 个参数传。
 *    2026-08-18 之前它被当成每页的页脚开销传（第 2 个参数），于是每一页都少了 80mm，
 *    一页只印得下 19 行 —— 客户「一页至少 20 行」的抱怨有一半是这么来的。
 */
const RICH_FOOTER_OVERHEAD_MM = 80

// 预渲染 CODE128 条形码为内嵌 SVG（不依赖外部 CDN，规避 CSP 拦截）
function barcodeSvg(code: string): string {
  if (typeof document === 'undefined' || !code) return ''
  try {
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
    JsBarcode(svg, code, { format: 'CODE128', width: 1.5, height: 45, displayValue: false, margin: 0 })
    svg.setAttribute('class', 'barcode-svg')
    return new XMLSerializer().serializeToString(svg)
  } catch {
    return ''
  }
}

export function buildOrderHtml(
  order: Order & { code?: string; deliveryDate?: string; internalNote?: string; externalNote?: string; salesman?: string; deliveryBatch?: string },
  customer: Customer | null,
  opts: { pageBreakAfter?: boolean; docType?: 'delivery' | 'sales' } = {}
): string {
  const docNoLabel = opts.docType === 'delivery' ? 'Delivery NO' : opts.docType === 'sales' ? 'Sale Order NO' : 'Invoice NO'
  // 送货单不含价格:隐藏单价/税/金额列与合计(价格在销售订单/发票上体现)
  const hidePrice = opts.docType === 'delivery'
  // 按商品 sequence 排（客户要求 2026-08-18）。原先靠 OrderLine.sequence，
  // 而实测 77.5% 的多行订单那个字段所有行都一样 —— 等于没排。见 lib/print/line-sort.ts
  const lines = sortLinesBySequence(order.lines ?? [])
  const subtotal = lines.reduce((s, l) => s + Number(l.subtotal), 0)

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
  const totalVat = Object.values(vatGroups).reduce((s, g) => s + g.vat, 0)
  const total = subtotal + totalVat

  const orderCode = order.code ?? order.id.slice(-8).toUpperCase()

  const customerAddr = [
    customer?.street || customer?.address,
    customer?.street2,
    customer?.city,
    customer?.zip,
  ].filter(Boolean).join(', ')

  const deliveryBatch = formatDriverSlotFromOrder(order)
  const salesman = order.salesman ?? ''
  const customerPhone = customer?.phone ?? order.internalNote ?? ''
  const deliveryDate = formatDateOnly(order.deliveryDate ?? order.quotationDate)

  const paymentTerm = customer?.paymentTerm ?? ''
  const paymentLabel = paymentTerm === 'cash' ? 'Immediate Payment' : paymentTerm === 'weekly' ? 'Weekly' : paymentTerm === 'monthly' ? 'Monthly' : ''
  const isImmediatePayment = paymentTerm === 'cash'
  const paymentColor = isImmediatePayment ? '#dc2626' : '#15803d'
  const paymentBg = isImmediatePayment ? '#fef2f2' : '#f0fdf4'
  const paymentBorder = isImmediatePayment ? '#ef4444' : '#16a34a'

  function renderLineRow(l: (typeof lines)[number], i: number): string {
    const spec = (l as unknown as { spec?: string }).spec
    const uomName = displayUomName((l as unknown as { uomName?: string }).uomName)
    const uomConversionHint = (l as unknown as { uomConversionHint?: string | null }).uomConversionHint
    const uomWeightHint = (l as unknown as { uomWeightHint?: string | null }).uomWeightHint
    const taxRate = Number(l.taxRate ?? 0)
    const inclVat = Number(l.subtotal) * (1 + taxRate / 100)
    return `
    <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
      <td class="col-qty">${Number(l.orderedQty).toFixed(2)}</td>
      <td class="col-unit">${uomName.toUpperCase()}</td>
      <td class="col-desc">
        <div class="prod-name">${l.productName}</div>
        ${spec ? `<div class="prod-spec">${spec}</div>` : ''}
        ${uomConversionHint ? `<div class="prod-spec">${uomConversionHint}${uomWeightHint ? ` (${uomWeightHint})` : ''}</div>` : ''}
        ${l.note ? `<div class="prod-note">${l.note}</div>` : ''}
      </td>
      ${hidePrice ? '' : `<td class="col-price">${eur(l.unitPrice)}</td>
      <td class="col-vat">${taxRate > 0 ? taxRate.toFixed(0) + '%' : '0%'}</td>
      <td class="col-incl">${eur(inclVat)}</td>`}
    </tr>`
  }

  const vatRowsHtml = Object.entries(vatGroups)
    .sort(([a], [b]) => parseFloat(a) - parseFloat(b))
    .map(([rate, { base, vat }]) => `
    <tr>
      <td class="total-label">VAT ${parseFloat(rate).toFixed(2)}% on ${eur(base)}</td>
      <td class="total-value">${eur(vat)}</td>
    </tr>`).join('')

  const headerBlockHtml = `
  <div class="header">
    <div>
      ${docBadge(opts.docType === 'delivery' ? 'delivery' : opts.docType === 'sales' ? 'salesOrder' : 'invoice')}
      <div class="company-name" style="margin-top:6px;">JohnstoneBros</div>
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
          <strong>${order.restaurantName}</strong><br/>
          ${customerAddr ? customerAddr + '<br/>' : ''}
          ${deliveryBatch ? '<strong>Driver:</strong> ' + deliveryBatch : ''}
        </div>
      </td>
      <td class="barcode-cell">
        <div class="info-head">${docNoLabel}</div>
        ${barcodeSvg(barcodeValue(orderCode, order.id))}
        <div class="barcode-code">${orderCode}</div>
      </td>
      <td>
        <div class="info-head">Delivery</div>
        <div class="info-val">
          ${deliveryDate}<br/>
          ${salesman ? '<strong>Salesman:</strong> ' + salesman : ''}
        </div>
      </td>
      <td>
        <div class="info-head">Payment</div>
        <div class="info-val">
          ${paymentLabel ? `<div style="font-weight:bold;color:${paymentColor};font-size:9.5pt;">${paymentLabel}</div>` : '<div style="color:#999;">—</div>'}
          ${customerPhone ? `<div style="margin-top:2mm;font-size:8.5pt;color:#555;">${customerPhone}</div>` : ''}
        </div>
      </td>
    </tr>
  </table>`

  const totalsBlockHtml = `
  ${hidePrice ? '' : `<div class="totals-wrap">
    <table class="totals-table">
      <tr>
        <td class="total-label">Subtotal</td>
        <td class="total-value">${eur(subtotal)}</td>
      </tr>
      ${vatRowsHtml}
      <tr class="total-grand">
        <td class="total-label">Total</td>
        <td class="total-value">${eur(total)}</td>
      </tr>
    </table>
  </div>`}

  ${paymentLabel ? `<div style="margin-top:12px;padding:8px 14px;border-radius:6px;border:2px solid ${paymentBorder};background:${paymentBg};display:inline-block;">
    <span style="font-size:12pt;font-weight:700;color:${paymentColor};letter-spacing:0.3px;">PAYMENT: ${paymentLabel}</span>
  </div>` : ''}

  ${(opts.docType === 'sales' || opts.docType === 'delivery') && customer?.externalNote ? `<div style="margin-top:16px;padding:10px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#374151;">
    <div style="font-weight:600;margin-bottom:4px;">客户备注 / Customer Note</div>
    <div style="white-space:pre-wrap;">${customer.externalNote}</div>
  </div>` : ''}

  ${order.externalNote ? `<div style="margin-top:16px;padding:10px 14px;background:#f9fafb;border:1px solid #e5e7eb;border-radius:6px;font-size:12px;color:#374151;">
    <div style="font-weight:600;margin-bottom:4px;">备注 / Order Note</div>
    <div style="white-space:pre-wrap;">${order.externalNote}</div>
  </div>` : ''}

  ${opts.docType === 'delivery' && order.deliveryNote ? `<div style="margin-top:16px;padding:10px 14px;background:#fff7ed;border:1px solid #fdba74;border-radius:6px;font-size:12px;color:#374151;">
    <div style="font-weight:600;margin-bottom:4px;">🚚 送货备注 / Delivery Note</div>
    <div style="white-space:pre-wrap;">${order.deliveryNote}</div>
  </div>` : ''}`

  // 明细多到一页放不下时按 chunkOrderLinesForPrint 手动分块，每块单独渲染成一个 .page、
  // 页头在每块顶部都重新画一次；页脚(联系方式+订单号-页码)同理每块都画一次——不能用
  // position:fixed 图省事，那样整份文档只有一份内容，没法按块显示不同的当前页码。
  // 第 2 个参数是每页的页脚（默认小字页脚），第 3 个才是最后一页的尾部内容 ——
  // 改造前把 80mm 当成每页开销传，导致每页都白留 80mm、只印 19 行
  const chunks = chunkOrderLinesForPrint(lines, undefined, RICH_FOOTER_OVERHEAD_MM)

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
        ${hidePrice ? '' : `<th class="col-price">PRICE</th>
        <th class="col-vat">VAT</th>
        <th class="col-incl">INCL VAT</th>`}
      </tr>
    </thead>
    <tbody>
      ${linesHtml || (isLastChunk ? `<tr><td colspan="${hidePrice ? 3 : 6}" style="text-align:center;padding:6mm;color:#999">No items</td></tr>` : '')}
    </tbody>
  </table>

  ${isLastChunk ? totalsBlockHtml : ''}

  <div class="footer-inpage">
    <hr class="footer-divider"/>
    <div class="footer-lines">
      Tel: (01) 830 8065 / 018308068 / 0879318299 &nbsp;&nbsp; Mail: info@johnstonebros.ie | johnstoneveg@gmail.com<br/>
      Web: https://m.johnstonebros.ie/ &nbsp;&nbsp; VAT: IE9739451J
    </div>
    <div class="footer-page-row">
      <span>${orderCode} - Page ${chunkIdx + 1}/${chunks.length}</span>
      <span>Print at: <span class="print-ts"></span></span>
    </div>
  </div>
</div>`
  }).join('')
}

export const CSS = `
* { margin:0; padding:0; box-sizing:border-box; }
body { font-family: Arial, Helvetica, sans-serif; font-size: 10pt; color: #111; background:#fff; }
.page { width: 210mm; min-height: 297mm; margin: 0 auto; padding: 12mm 12mm 22mm; position: relative; }

.header { display: flex; justify-content: space-between; align-items: flex-start; margin-bottom: 5mm; padding-bottom: 3mm; border-bottom: 2px solid #1a3a2a; }
.company-name { font-size: 26pt; font-weight: bold; font-style: italic; color: #1a3a2a; }
.company-addr { text-align: right; font-size: 8.5pt; color: #444; line-height: 1.6; }

.info-table { width: 100%; border-collapse: collapse; margin-bottom: 4.5mm; }
.info-table td { border: 1px solid #bbb; padding: 2mm 3mm; vertical-align: top; width: 25%; }
.info-head { font-size: 7pt; font-weight: bold; color: #666; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 2mm; }
.info-val  { font-size: 9pt; color: #111; line-height: 1.6; }
.barcode-cell { text-align: center; }
.barcode-svg { max-width: 100%; height: 17mm; display: block; margin: 0 auto; }
.barcode-code { font-size: 9pt; font-weight: bold; margin-top: 1mm; letter-spacing: 1px; }

.lines-table { width: 100%; border-collapse: collapse; margin-bottom: 5mm; }
.lines-table thead tr { background: #1a3a2a; color: #fff; }
.lines-table thead th { padding: 1.6mm 2.5mm; font-size: 8pt; font-weight: bold; text-transform: uppercase; letter-spacing: 0.3px; }
.lines-table tbody tr.row-even { background: #fff; }
.lines-table tbody tr.row-odd  { background: #f7f7f7; }
/* 行高与 lib/order-pdf.ts 同一口径（客户要求一页至少 20 行，2026-08-18）。
   ⚠️ 这个页面是**手工预估分页**的（chunkOrderLinesForPrint），改这里的行高
   必须同步改 lib/print/trip-common.ts 的 PRINT_ROW_BASE_MM ——
   预估比实际小就会真的溢出，比不改还糟。 */
.lines-table tbody td { padding: 1.1mm 2.5mm; font-size: 8.5pt; line-height: 1.25; border-bottom: 1px solid #e8e8e8; vertical-align: top; }

.col-qty   { text-align: right; width: 10%; }
.col-unit  { text-align: left;  width: 9%; }
.col-desc  { text-align: left;  width: 43%; }
.col-price { text-align: right; width: 12%; }
.col-vat   { text-align: center; width: 7%; }
.col-incl  { text-align: right; width: 13%; }

.prod-name { font-weight: normal; }
.prod-spec { color: #666; font-size: 8pt; margin-top: 1px; }
.prod-note { color: #b45309; font-size: 8pt; font-style: italic; margin-top: 1px; }

.totals-wrap { display: flex; justify-content: flex-end; margin-bottom: 6mm; }
.totals-table { width: 260px; border-collapse: collapse; border: 1px solid #ccc; }
.totals-table tr td { padding: 2mm 4mm; font-size: 9.5pt; border-bottom: 1px solid #e0e0e0; }
.total-label { color: #555; }
.total-value { text-align: right; }
.total-grand td { font-weight: bold; font-size: 11pt; color: #111; border-top: 2px solid #333; border-bottom: none; }

.footer-inpage {
  position: absolute;
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
}
`

export default function PrintPage() {
  const params = useParams<{ id: string }>()
  const id = params.id
  const [html, setHtml] = useState<string>('')
  const [ready, setReady] = useState(false)

  const [isPreview, setIsPreview] = useState(false)
  const iframeRef = useRef<HTMLIFrameElement>(null)

  useEffect(() => {
    async function load() {
      try {
        const search = new URLSearchParams(window.location.search)
        const docParam = search.get('doc')
        const preview = search.get('preview') === '1'
        setIsPreview(preview)
        const docType: 'delivery' | 'sales' | undefined =
          docParam === 'delivery' ? 'delivery' : docParam === 'sales' ? 'sales' : undefined
        const docTitle = docType === 'delivery' ? 'Delivery Note' : docType === 'sales' ? 'Sale Order' : 'Invoice'
        const [order, customers] = await Promise.all([
          apiGet<Order & { code?: string; deliveryDate?: string; internalNote?: string; externalNote?: string; salesman?: string; deliveryBatch?: string }>(`/api/orders/${id}`),
          apiGet<Customer[]>('/api/customers').catch(() => [] as Customer[]),
        ])
        const customer = customers.find(c => c.id === order.restaurantId) ?? null
        const orderCode = order.code ?? order.id.slice(-8).toUpperCase()

        const bodyHtml = buildOrderHtml(order, customer, { docType })

        setHtml(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${docTitle} ${orderCode}</title>
<style>${CSS}</style>
</head>
<body>
${bodyHtml}

<script>
  var ts = new Date();
  var pad = function(n){ return n < 10 ? '0'+n : ''+n; };
  var stamp = pad(ts.getDate()) + '/' + pad(ts.getMonth()+1) + '/' + ts.getFullYear() +
    ' ' + pad(ts.getHours()) + ':' + pad(ts.getMinutes());
  // 订单被分成多页时，每页都有自己的一份页脚(见 footer-inpage)，逐个填充时间戳
  document.querySelectorAll('.print-ts').forEach(function(el){ el.textContent = stamp; });
  // 打印在本文档(iframe)自己的脚本里触发，父页面只 postMessage 通知，不直接调用
  // contentWindow.print()——后者是同步跨窗口调用，会连带卡住父页面的事件循环。
  window.addEventListener('message', function(e){ if (e.data === 'print' && e.source === window.parent) window.print(); });
  ${preview ? '' : 'window.print();'}
<\/script>
</body>
</html>`)
        setReady(true)
      } catch (e) {
        console.error('Print page load failed:', e)
      }
    }
    load()
  }, [id])

  if (!ready) {
    return (
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'Arial, sans-serif', color: '#666' }}>
        Loading invoice…
      </div>
    )
  }

  return (
    <>
      <iframe
        ref={iframeRef}
        srcDoc={html}
        title="print"
        style={{ position: 'fixed', inset: 0, width: '100vw', height: '100vh', border: 'none' }}
      />
      {isPreview && (
        <button
          onClick={() => iframeRef.current?.contentWindow?.postMessage('print', '*')}
          style={{
            position: 'fixed', top: 12, right: 12, zIndex: 10,
            padding: '8px 16px', fontSize: 14, fontWeight: 600,
            background: '#875A7B', color: '#fff', border: 'none', borderRadius: 6,
            cursor: 'pointer', boxShadow: '0 2px 8px rgba(0,0,0,0.2)',
          }}
        >
          🖨 Print
        </button>
      )}
    </>
  )
}
