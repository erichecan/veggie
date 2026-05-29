/**
 * Trip 拣货单 — 按商品汇总，区分整箱/散装，给拣货员使用
 *
 * 布局：
 *   顶部：批次信息 + 日期 + 司机
 *   整箱商品表格（goodsType=BULK 或箱装 UOM）
 *   散装商品表格（其余商品）
 *   底部：所有订单号 + 条形码（供扫码枪扫描）
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

function fmtQty(v: number): string {
  if (v === Math.floor(v)) return String(v)
  return v.toFixed(3).replace(/0+$/, '').replace(/\.$/, '')
}

interface AggProduct {
  productId: string
  productName: string
  spec: string
  uomName: string
  totalQty: number
  isBulk: boolean
  orderCodes: string[]
}

function isBulkItem(uomName: string, goodsType: string | null): boolean {
  if (goodsType === 'BULK') return true
  const lower = (uomName || '').toLowerCase()
  return lower.includes('case') || lower.includes('box') || lower.includes('bag')
    || lower.includes('箱') || lower.includes('bag') || lower.includes('sack')
    || lower.includes('tray') || lower.includes('crate')
}

export function generateTripPickingHtml(data: TripPrintData): string {
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
  const dateStr = deliveryDates.length > 0
    ? fmtDateUK(deliveryDates.reduce((a, b) => (a < b ? a : b)))
    : fmtDateUK(trip.departTime)

  // Aggregate products across all orders
  const aggMap = new Map<string, AggProduct>()
  for (const order of orders) {
    const orderCode = order.code ?? order.id.slice(0, 8).toUpperCase()
    for (const line of order.lines) {
      const key = line.productId
      const existing = aggMap.get(key)
      if (existing) {
        existing.totalQty += line.orderedQty
        if (!existing.orderCodes.includes(orderCode)) {
          existing.orderCodes.push(orderCode)
        }
      } else {
        aggMap.set(key, {
          productId: line.productId,
          productName: line.productName,
          spec: line.spec ?? '',
          uomName: line.uomName ?? '',
          totalQty: line.orderedQty,
          isBulk: isBulkItem(line.uomName ?? '', line.goodsType),
          orderCodes: [orderCode],
        })
      }
    }
  }

  const allProducts = Array.from(aggMap.values())
  const bulkProducts = allProducts.filter(p => p.isBulk).sort((a, b) => a.productName.localeCompare(b.productName))
  const looseProducts = allProducts.filter(p => !p.isBulk).sort((a, b) => a.productName.localeCompare(b.productName))

  function productTableHtml(title: string, products: AggProduct[], icon: string): string {
    if (products.length === 0) return ''
    const rows = products.map((p, i) => `
      <tr class="${i % 2 === 0 ? 'row-even' : 'row-odd'}">
        <td class="col-seq">${i + 1}</td>
        <td class="col-name">
          ${escapeHtml(p.productName)}
          ${p.spec ? `<span class="spec">${escapeHtml(p.spec)}</span>` : ''}
        </td>
        <td class="col-qty">${fmtQty(p.totalQty)}</td>
        <td class="col-uom">${escapeHtml(p.uomName)}</td>
        <td class="col-check"></td>
      </tr>
    `).join('')

    return `
    <div class="section-header">${icon} ${escapeHtml(title)}（${products.length} 种）</div>
    <table class="pick-table">
      <thead>
        <tr>
          <th class="col-seq">#</th>
          <th class="col-name">商品名称</th>
          <th class="col-qty">总数量</th>
          <th class="col-uom">单位</th>
          <th class="col-check">✓</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
  }

  // Order barcodes at the bottom
  const orderBarcodes = orders.map(o => {
    const code = o.code ?? o.id.slice(0, 8).toUpperCase()
    const safeCode = code.replace(/['"\\]/g, '')
    return `
    <div class="bc-item">
      <svg id="bc-${safeCode}" class="bc-svg"></svg>
      <div class="bc-label">${escapeHtml(code)}</div>
      <div class="bc-customer">${escapeHtml(o.customerName)}</div>
    </div>`
  }).join('')

  const barcodeInits = orders.map(o => {
    const code = o.code ?? o.id.slice(0, 8).toUpperCase()
    const safeCode = code.replace(/['"\\]/g, '')
    return `try{JsBarcode('#bc-${safeCode}',${JSON.stringify(code)},{format:'CODE128',width:1.5,height:40,displayValue:false,margin:0});}catch(e){}`
  }).join('\n')

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>拣货单 — ${escapeHtml(teamStr)}</title>
<script src="https://cdn.jsdelivr.net/npm/jsbarcode@3.12.3/dist/JsBarcode.all.min.js"><\/script>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;background:#fff}
  body{padding:14px 20px}

  .page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid #1a3a2a}
  .page-header .title{font-size:18px;font-weight:700;color:#1a3a2a}
  .page-header .meta{font-size:10px;color:#333;text-align:right;line-height:1.6}

  .info-row{display:flex;gap:20px;margin-bottom:10px;font-size:11px;padding:6px 8px;background:#f5f5f5;border-radius:4px}
  .info-row .item .label{font-weight:700;color:#555}

  .section-header{font-size:13px;font-weight:700;color:#1a3a2a;margin:14px 0 4px;padding:4px 8px;background:#e8f0ec;border-left:3px solid #1a3a2a}

  table.pick-table{width:100%;border-collapse:collapse;font-size:11px;margin-bottom:8px}
  table.pick-table th{background:#1a3a2a;color:#fff;padding:5px 8px;font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.3px}
  table.pick-table td{border-bottom:1px solid #ddd;padding:4px 8px;vertical-align:top}
  table.pick-table tr.row-even{background:#fff}
  table.pick-table tr.row-odd{background:#f8f8f8}

  .col-seq{width:30px;text-align:center}
  .col-name{width:auto}
  .col-qty{width:80px;text-align:right;font-weight:700;font-size:13px}
  .col-uom{width:80px;text-align:center;color:#555}
  .col-check{width:40px;text-align:center;border:1px solid #ccc!important}

  .spec{display:block;font-size:9px;color:#888;margin-top:1px}

  .orders-section{margin-top:16px;padding-top:10px;border-top:2px solid #1a3a2a}
  .orders-title{font-size:12px;font-weight:700;color:#1a3a2a;margin-bottom:8px}
  .bc-grid{display:flex;flex-wrap:wrap;gap:12px}
  .bc-item{text-align:center;border:1px solid #ddd;padding:6px 10px;border-radius:4px;min-width:140px}
  .bc-svg{max-width:100%;height:32px;display:block;margin:0 auto 2px}
  .bc-label{font-size:10px;font-weight:700;letter-spacing:.5px}
  .bc-customer{font-size:9px;color:#666;margin-top:1px}

  .stats{margin-top:12px;font-size:10px;color:#555;display:flex;gap:16px}
  .stats .num{font-weight:700;color:#000}

  @media print{
    body{padding:0}
    @page{margin:10mm 8mm}
  }
</style>
</head>
<body>
  <div class="page-header">
    <div class="title">拣货单 PICKING LIST</div>
    <div class="meta">
      ${fmtDateUK(new Date().toISOString())}<br/>
      共 ${orders.length} 单 · ${allProducts.length} 种商品
    </div>
  </div>

  <div class="info-row">
    <div class="item"><span class="label">配送日期：</span>${dateStr}</div>
    <div class="item"><span class="label">司机/批次：</span>${escapeHtml(teamStr)}</div>
    <div class="item"><span class="label">客户数：</span>${new Set(orders.map(o => o.customerId)).size}</div>
  </div>

  ${productTableHtml('整箱商品 CASE/BULK', bulkProducts, '📦')}
  ${productTableHtml('散装商品 LOOSE', looseProducts, '🥬')}

  <div class="stats">
    <span>整箱 <span class="num">${bulkProducts.length}</span> 种</span>
    <span>散装 <span class="num">${looseProducts.length}</span> 种</span>
    <span>合计 <span class="num">${allProducts.length}</span> 种</span>
  </div>

  <div class="orders-section">
    <div class="orders-title">关联订单（扫码查询）</div>
    <div class="bc-grid">
      ${orderBarcodes}
    </div>
  </div>

<script>
  ${barcodeInits}
  window.print();
<\/script>
</body>
</html>`
}
