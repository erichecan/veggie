/**
 * 客户签收单（Proof of Delivery）
 *
 * 合同第四条把「客户签收单」列进打印中心必须支持的单据里，审计实测这是 6 类单据中
 * 唯一缺的一类。它与送货单的区别：送货单是**送货前**给客户看货与价的，
 * 签收单是**送货后**的凭证——重点在谁签的、什么时候签的、签名长什么样。
 *
 * 一站一页。已签收的印出手写签名图与签收人、签收时间；未签收的印空白签名栏，
 * 供纸质补签——现场断网或客户坚持要纸质回单时仍然可用。
 */

import {
  type TripPrintData,
  type TripOrder,
  type TripCustomer,
  type TripSignoff,
  escapeHtml,
  fmtQty,
  formatTripDriverLabel,
} from './trip-common'
import { sortLinesBySequence } from '@/lib/print/line-sort'
import { docBadge } from './doc-badge'
import { formatDateOnly } from '@/lib/format-date'
import { displayUomName } from '@/lib/sale-uom'
import { formatUomConversionHint } from '@/lib/print/uom-conversion'
import type { PrintLang } from '@/lib/print/print-i18n'

const T = {
  zh: {
    docTitle: '客户签收单',
    noLineDetail: '本站无明细',
    customerSignatureAlt: '客户签名',
    signedBy: '签收人：',
    signedAt: '签收时间：',
    signHereLabel: '签收人签名 / 日期　　',
    pendingSign: '未电子签收，请客户在此手签',
    deliveryDate: '配送日期',
    driver: '司机',
    relatedOrders: '关联订单',
    phone: '电话',
    actualPayment: '实收货款',
    totalDue: '应收合计',
    colProduct: '商品',
    colSpec: '规格',
    colQtyReceived: '实收数量',
    colUnit: '单位',
    colAmount: '金额',
    total: '合计',
    signConfirmLabel: '客户签收确认（签字即表示已核对上述货品与数量）',
    footNote: '本单一式一份，作为收货凭证',
    noSignoffRecords: '本行程无可打印的签收记录',
    orderCodeSep: '、',
    dateLocale: 'zh-CN',
  },
  en: {
    docTitle: 'Proof of Delivery',
    noLineDetail: 'No items for this stop',
    customerSignatureAlt: 'Customer signature',
    signedBy: 'Signed by: ',
    signedAt: 'Signed at: ',
    signHereLabel: 'Customer signature / date',
    pendingSign: 'Not signed electronically, please sign here',
    deliveryDate: 'Delivery Date',
    driver: 'Driver',
    relatedOrders: 'Related Orders',
    phone: 'Phone',
    actualPayment: 'Payment Received',
    totalDue: 'Total Due',
    colProduct: 'Product',
    colSpec: 'Spec',
    colQtyReceived: 'Qty Received',
    colUnit: 'Unit',
    colAmount: 'Amount',
    total: 'Total',
    signConfirmLabel: 'Customer confirmation (signing confirms the goods and quantities above)',
    footNote: 'This is a single-copy proof of delivery',
    noSignoffRecords: 'No printable signoff records for this trip',
    orderCodeSep: ', ',
    dateLocale: 'en-IE',
  },
} as const

const CSS = `
  @page { size: A4; margin: 12mm 10mm; }
  * { box-sizing: border-box; }
  body { margin:0; font-family: -apple-system, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
         color:#111827; font-size:10pt; }
  .page { page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .head { display:flex; justify-content:space-between; align-items:flex-start; gap:8mm;
          border-bottom:2px solid #111827; padding-bottom:3mm; margin-bottom:4mm; }
  .co { font-size:15pt; font-weight:700; letter-spacing:-0.3px; }
  .co-sub { font-size:8.5pt; color:#6b7280; margin-top:1mm; }
  .meta { text-align:right; font-size:9pt; line-height:1.6; }
  .meta b { font-weight:600; }
  .cust { display:flex; justify-content:space-between; gap:8mm; margin-bottom:4mm; }
  .cust h2 { margin:0 0 1mm; font-size:12pt; }
  .addr { font-size:9pt; color:#374151; line-height:1.5; max-width:90mm; }
  table { width:100%; border-collapse:collapse; font-size:9pt; }
  thead th { background:#f3f4f6; text-align:left; padding:2mm 2.5mm; font-weight:600;
             border-bottom:1px solid #d1d5db; }
  tbody td { padding:1.6mm 2.5mm; border-bottom:1px solid #f0f0f0; }
  .num { text-align:right; font-variant-numeric: tabular-nums; }
  tfoot td { padding:2.5mm; font-weight:700; border-top:2px solid #111827; }
  .signbox { margin-top:8mm; display:flex; gap:8mm; align-items:flex-end; }
  .sigcell { flex:1; }
  .siglabel { font-size:8.5pt; color:#6b7280; margin-bottom:1.5mm; }
  .sigimg { height:26mm; border:1px solid #e5e7eb; border-radius:2px; background:#fff;
            display:flex; align-items:center; justify-content:center; padding:2mm; }
  .sigimg img { max-height:100%; max-width:100%; object-fit:contain; }
  .sigline { height:26mm; border-bottom:1px solid #111827; }
  .sigmeta { font-size:8.5pt; color:#374151; margin-top:1.5mm; }
  .pending { display:inline-block; background:#fef3c7; color:#92400e; border:1px solid #f59e0b;
             padding:1mm 2.5mm; border-radius:2px; font-size:8.5pt; font-weight:600; }
  .foot { margin-top:6mm; padding-top:2mm; border-top:1px solid #e5e7eb;
          font-size:8pt; color:#9ca3af; display:flex; justify-content:space-between; }
`

function money(n: number): string {
  return '€' + n.toFixed(2)
}

function addressOf(c: TripCustomer | undefined): string {
  if (!c) return ''
  return [c.street, c.street2, c.city, c.zip, c.country]
    .filter(v => v && String(v).trim())
    .map(v => escapeHtml(String(v)))
    .join(', ')
}

function buildReceiptPage(
  sign: TripSignoff,
  orders: TripOrder[],
  customer: TripCustomer | undefined,
  driverLabel: string,
  tripDate: string,
  t: typeof T[PrintLang],
): string {
  // 按商品 sequence 排（客户要求 2026-08-18），与其它单据同口径
  const lines = sortLinesBySequence(orders.flatMap(o => o.lines ?? []))
  const total = lines.reduce((s, l) => s + (l.subtotal ?? 0), 0)
  const orderCodes = orders.map(o => o.code ?? o.id.slice(-8).toUpperCase()).join(t.orderCodeSep)

  const rows = lines.length > 0
    ? lines.map(l => {
      const uomHint = formatUomConversionHint(l.uomConversion ?? undefined, Number(l.orderedQty ?? 0))
      const specText = [l.spec, uomHint?.conversionLine, uomHint?.weightLine].filter(Boolean).join(' · ')
      return `
      <tr>
        <td>${escapeHtml(l.productName ?? '')}</td>
        <td>${escapeHtml(specText)}</td>
        <td class="num">${fmtQty(l.orderedQty ?? 0)}</td>
        <td class="num">${escapeHtml(displayUomName(l.uomName))}</td>
        <td class="num">${money(l.subtotal ?? 0)}</td>
      </tr>`
    }).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:6mm;">${t.noLineDetail}</td></tr>`

  // 已签收印签名图；未签收留空白签名栏供纸质补签
  const signCell = sign.signature
    ? `<div class="sigimg"><img src="${sign.signature}" alt="${t.customerSignatureAlt}"/></div>
       <div class="sigmeta">
         ${t.signedBy}<b>${escapeHtml(sign.signerName ?? '—')}</b>
         ${sign.signedAt ? ` · ${t.signedAt}${new Date(sign.signedAt).toLocaleString(t.dateLocale)}` : ''}
       </div>`
    : `<div class="sigline"></div>
       <div class="sigmeta">${t.signHereLabel}<span class="pending">${t.pendingSign}</span></div>`

  return `
<div class="page">
  <div class="head">
    <div>
      ${docBadge('receipt')}
      <div class="co" style="margin-top:2.5mm;">JohnstoneBros</div>
      <div class="co-sub">Fresh Produce Wholesale</div>
    </div>
    <div class="meta">
      <div><b>${t.deliveryDate}</b> ${escapeHtml(tripDate)}</div>
      <div><b>${t.driver}</b> ${escapeHtml(driverLabel)}</div>
      <div><b>${t.relatedOrders}</b> ${escapeHtml(orderCodes || '—')}</div>
    </div>
  </div>

  <div class="cust">
    <div>
      <h2>${escapeHtml(sign.restaurantName || customer?.name || '')}</h2>
      <div class="addr">${addressOf(customer)}</div>
      ${customer?.phone ? `<div class="addr">${t.phone} ${escapeHtml(customer.phone)}</div>` : ''}
    </div>
    <div class="meta">
      ${sign.payment != null ? `<div><b>${t.actualPayment}</b> ${money(sign.payment)}</div>` : ''}
      <div><b>${t.totalDue}</b> ${money(total)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>${t.colProduct}</th><th>${t.colSpec}</th>
        <th class="num">${t.colQtyReceived}</th><th class="num">${t.colUnit}</th><th class="num">${t.colAmount}</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="4" class="num">${t.total}</td><td class="num">${money(total)}</td></tr>
    </tfoot>
  </table>

  <div class="signbox">
    <div class="sigcell">
      <div class="siglabel">${t.signConfirmLabel}</div>
      ${signCell}
    </div>
  </div>

  <div class="foot">
    <span>${t.footNote}</span>
    <span>${escapeHtml(sign.restaurantName || '')}</span>
  </div>
</div>`
}

export function generateTripReceiptHtml(data: TripPrintData, lang: PrintLang = 'zh'): string {
  const { trip, orders, customers, signoffs } = data
  const t = T[lang]
  const driverLabel = formatTripDriverLabel(trip)
  const tripDate = formatDateOnly(trip.createdAt) ?? ''

  // 没有签收记录（老数据）时按订单的客户兜底，保证这张单永远打得出来
  const list: TripSignoff[] = signoffs && signoffs.length > 0
    ? signoffs
    : [...new Map(orders.map(o => [o.customerId || o.id, {
        restaurantId: o.customerId ?? '',
        restaurantName: o.customerName ?? '',
        orderIds: [o.id],
        delivered: false,
        payment: null,
        signature: null,
        signerName: null,
        signedAt: null,
      } as TripSignoff])).values()]

  const pages = list.map(sign => {
    const mine = orders.filter(o => sign.orderIds.includes(o.id))
    const customer = customers.get(sign.restaurantId)
      ?? (mine[0]?.customerId ? customers.get(mine[0].customerId) : undefined)
    return buildReceiptPage(sign, mine, customer, driverLabel, tripDate, t)
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="${lang}">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>${t.docTitle}</title>
<style>${CSS}</style>
</head>
<body>
${pages || `<p style="padding:20mm;text-align:center;color:#9ca3af;">${t.noSignoffRecords}</p>`}
<script>
  window.print();
<\/script>
</body>
</html>`
}
