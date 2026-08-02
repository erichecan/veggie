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
import { docBadge } from './doc-badge'
import { formatDateOnly } from '@/lib/format-date'

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
): string {
  const lines = orders.flatMap(o => o.lines ?? [])
  const total = lines.reduce((s, l) => s + (l.subtotal ?? 0), 0)
  const orderCodes = orders.map(o => o.code ?? o.id.slice(-8).toUpperCase()).join('、')

  const rows = lines.length > 0
    ? lines.map(l => `
      <tr>
        <td>${escapeHtml(l.productName ?? '')}</td>
        <td>${escapeHtml(l.spec ?? '')}</td>
        <td class="num">${fmtQty(l.orderedQty ?? 0)}</td>
        <td class="num">${escapeHtml(l.uomName ?? '')}</td>
        <td class="num">${money(l.subtotal ?? 0)}</td>
      </tr>`).join('')
    : `<tr><td colspan="5" style="text-align:center;color:#9ca3af;padding:6mm;">本站无明细</td></tr>`

  // 已签收印签名图；未签收留空白签名栏供纸质补签
  const signCell = sign.signature
    ? `<div class="sigimg"><img src="${sign.signature}" alt="客户签名"/></div>
       <div class="sigmeta">
         签收人：<b>${escapeHtml(sign.signerName ?? '—')}</b>
         ${sign.signedAt ? ` · 签收时间：${new Date(sign.signedAt).toLocaleString('zh-CN')}` : ''}
       </div>`
    : `<div class="sigline"></div>
       <div class="sigmeta">签收人签名 / 日期　　<span class="pending">未电子签收，请客户在此手签</span></div>`

  return `
<div class="page">
  <div class="head">
    <div>
      ${docBadge('receipt')}
      <div class="co" style="margin-top:2.5mm;">JohnstoneBros</div>
      <div class="co-sub">Fresh Produce Wholesale</div>
    </div>
    <div class="meta">
      <div><b>配送日期</b> ${escapeHtml(tripDate)}</div>
      <div><b>司机</b> ${escapeHtml(driverLabel)}</div>
      <div><b>关联订单</b> ${escapeHtml(orderCodes || '—')}</div>
    </div>
  </div>

  <div class="cust">
    <div>
      <h2>${escapeHtml(sign.restaurantName || customer?.name || '')}</h2>
      <div class="addr">${addressOf(customer)}</div>
      ${customer?.phone ? `<div class="addr">电话 ${escapeHtml(customer.phone)}</div>` : ''}
    </div>
    <div class="meta">
      ${sign.payment != null ? `<div><b>实收货款</b> ${money(sign.payment)}</div>` : ''}
      <div><b>应收合计</b> ${money(total)}</div>
    </div>
  </div>

  <table>
    <thead>
      <tr>
        <th>商品</th><th>规格</th>
        <th class="num">实收数量</th><th class="num">单位</th><th class="num">金额</th>
      </tr>
    </thead>
    <tbody>${rows}</tbody>
    <tfoot>
      <tr><td colspan="4" class="num">合计</td><td class="num">${money(total)}</td></tr>
    </tfoot>
  </table>

  <div class="signbox">
    <div class="sigcell">
      <div class="siglabel">客户签收确认（签字即表示已核对上述货品与数量）</div>
      ${signCell}
    </div>
  </div>

  <div class="foot">
    <span>本单一式一份，作为收货凭证</span>
    <span>${escapeHtml(sign.restaurantName || '')}</span>
  </div>
</div>`
}

export function generateTripReceiptHtml(data: TripPrintData): string {
  const { trip, orders, customers, signoffs } = data
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
    return buildReceiptPage(sign, mine, customer, driverLabel, tripDate)
  }).join('\n')

  return `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>客户签收单</title>
<style>${CSS}</style>
</head>
<body>
${pages || '<p style="padding:20mm;text-align:center;color:#9ca3af;">本行程无可打印的签收记录</p>'}
<script>
  window.print();
<\/script>
</body>
</html>`
}
