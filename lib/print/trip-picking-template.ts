/**
 * Trip 拣货单 — 按商品汇总，区分实物商品/耗材，给拣货员使用
 *
 * 布局：
 *   顶部：批次信息 + 日期 + 司机
 *   实物商品表格（ProductTemplate.type === 'PRODUCT'，或 type 未知）
 *   耗材表格（ProductTemplate.type === 'CONSU'）
 *
 * variant 决定印出哪一部分，供两个拣货员分开作业：
 *   'all'        —— 实物 + 耗材（默认，兼容旧链接）
 *   'storable'   —— 只印实物，给整箱整袋的拣货员
 *   'consumable' —— 只印耗材，给零散货的拣货员
 */

import {
  type GoodsType,
  type TripPrintData,
  escapeHtml,
} from './trip-common'
import { docBadge } from './doc-badge'
import { formatDateOnly } from '@/lib/format-date'

function fmtQty(v: number): string {
  if (v === Math.floor(v)) return String(v)
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

interface CustomerBreakdown {
  customerId: string
  customerName: string
  qty: number
  /** 行级备注（如"15个正常价+5个打折处理"），拣货时需要醒目提示 */
  note?: string
}

interface AggProduct {
  productId: string
  /** 多单位销售(20260714)：同商品不同下单单位(如箱/个)分开聚合，不混算总量 */
  uomId: string | null
  productName: string
  spec: string
  uomName: string
  totalQty: number
  /** ProductTemplate.type: 'PRODUCT' | 'CONSU' | 'SERVICE' | null */
  productType: string | null
  /** 'LOOSE'(散称,按重量卖) 时按客户展示明细子行；'BULK'/null 只显示总量 */
  goodsType: GoodsType
  orderCodes: string[]
  byCustomer: Map<string, CustomerBreakdown>
}

export type PickingVariant = 'all' | 'storable' | 'consumable'

export function generateTripPickingHtml(
  data: TripPrintData,
  variant: PickingVariant = 'all',
): string {
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
    ? formatDateOnly(deliveryDates.reduce((a, b) => (a < b ? a : b)))
    : formatDateOnly(trip.departTime)

  // Aggregate products across all orders
  const aggMap = new Map<string, AggProduct>()
  for (const order of orders) {
    const orderCode = order.code ?? order.id.slice(0, 8).toUpperCase()
    const customerId = order.customerId ?? orderCode
    const customerName = order.customerName ?? orderCode
    for (const line of order.lines) {
      const key = `${line.productId}::${line.uomId ?? ''}`
      let agg = aggMap.get(key)
      if (!agg) {
        agg = {
          productId: line.productId,
          uomId: line.uomId,
          productName: line.productName,
          spec: line.spec ?? '',
          uomName: line.uomName ?? '',
          totalQty: 0,
          productType: line.productType ?? null,
          goodsType: line.goodsType ?? null,
          orderCodes: [],
          byCustomer: new Map<string, CustomerBreakdown>(),
        }
        aggMap.set(key, agg)
      }
      // 同一商品理论上 goodsType 恒定；任一行判为 LOOSE 就展示明细，容错优先
      if (line.goodsType === 'LOOSE') agg.goodsType = 'LOOSE'
      agg.totalQty += line.orderedQty
      if (!agg.orderCodes.includes(orderCode)) {
        agg.orderCodes.push(orderCode)
      }
      const bd = agg.byCustomer.get(customerId)
      if (bd) {
        bd.qty += line.orderedQty
        if (line.note && line.note !== bd.note) bd.note = bd.note ? `${bd.note}；${line.note}` : line.note
      } else {
        agg.byCustomer.set(customerId, { customerId, customerName, qty: line.orderedQty, note: line.note ?? undefined })
      }
    }
  }

  const allProducts = Array.from(aggMap.values())
  const consumableProducts = allProducts.filter(p => p.productType === 'CONSU').sort((a, b) => a.productName.localeCompare(b.productName))
  const storableProducts = allProducts.filter(p => p.productType !== 'CONSU').sort((a, b) => a.productName.localeCompare(b.productName))

  const showStorable = variant !== 'consumable'
  const showConsumable = variant !== 'storable'
  const visibleCount =
    (showStorable ? storableProducts.length : 0) +
    (showConsumable ? consumableProducts.length : 0)
  const variantLabel =
    variant === 'storable' ? '整箱整袋 STOCKABLE'
    : variant === 'consumable' ? '零散货 CONSUMABLE'
    : ''

  function productTableHtml(title: string, products: AggProduct[], icon: string): string {
    if (products.length === 0) return ''
    const rows = products.map((p, i) => {
      const rowClass = i % 2 === 0 ? 'row-even' : 'row-odd'
      const hasNote = Array.from(p.byCustomer.values()).some(bd => bd.note)
      const mainRow = `
      <tr class="${rowClass}">
        <td class="col-seq">${i + 1}</td>
        <td class="col-name">
          ${escapeHtml(p.productName)}
          ${p.spec ? `<span class="spec">${escapeHtml(p.spec)}</span>` : ''}
          ${hasNote ? `<span class="note-flag">⚠️ 有备注，见下方明细</span>` : ''}
        </td>
        <td class="col-qty">${fmtQty(p.totalQty)}</td>
        <td class="col-uom">${escapeHtml(p.uomName)}</td>
        <td class="col-check"></td>
      </tr>`
      // 散称/按重量卖的商品按客户展示明细子行；带备注的商品即便不是散称，也强制展开，避免备注被折叠看不到
      const breakdownRows = (p.goodsType === 'LOOSE' || hasNote)
        ? Array.from(p.byCustomer.values())
            .sort((a, b) => a.customerName.localeCompare(b.customerName))
            .map(bd => `
      <tr class="row-bd">
        <td class="col-seq"></td>
        <td class="col-name bd-name">
          ↳ ${escapeHtml(bd.customerName)}
          ${bd.note ? `<span class="note-badge">⚠️ ${escapeHtml(bd.note)}</span>` : ''}
        </td>
        <td class="col-qty bd-qty">${fmtQty(bd.qty)}</td>
        <td class="col-uom"></td>
        <td class="col-check"></td>
      </tr>`).join('')
        : ''
      return mainRow + breakdownRows
    }).join('')

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

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>拣货单${variantLabel ? ' · ' + escapeHtml(variantLabel) : ''} — ${escapeHtml(teamStr)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{font-family:Arial,Helvetica,sans-serif;font-size:11px;color:#000;background:#fff}
  body{padding:14px 20px}

  .page-header{display:flex;justify-content:space-between;align-items:flex-start;margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid #1a3a2a}
  .page-header .title{font-size:18px;font-weight:700;color:#1a3a2a}
  .page-header .variant-tag{display:inline-block;margin-left:8px;font-size:13px;font-weight:700;color:#fff;background:#1a3a2a;padding:1px 8px;border-radius:4px;vertical-align:middle}
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
  .note-flag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;vertical-align:middle}
  .note-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #f59e0b}

  tr.row-bd td{border-bottom:1px dashed #e0e0e0;padding-top:2px;padding-bottom:2px}
  .bd-name{padding-left:26px!important;color:#555;font-size:10px}
  .bd-qty{font-weight:600!important;font-size:11px!important;color:#555}

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
    ${docBadge('picking', variantLabel ? escapeHtml(variantLabel) : undefined)}
    <div class="meta">
      ${formatDateOnly(new Date().toISOString())}<br/>
      共 ${orders.length} 单 · ${visibleCount} 种商品
    </div>
  </div>

  <div class="info-row">
    <div class="item"><span class="label">配送日期：</span>${dateStr}</div>
    <div class="item"><span class="label">司机/批次：</span>${escapeHtml(teamStr)}</div>
    <div class="item"><span class="label">客户数：</span>${new Set(orders.map(o => o.customerId)).size}</div>
  </div>

  ${showStorable ? productTableHtml('整箱整袋 STOCKABLE', storableProducts, '📦') : ''}
  ${showConsumable ? productTableHtml('零散货 CONSUMABLE', consumableProducts, '🧴') : ''}

  <div class="stats">
    ${showStorable ? `<span>整箱整袋 <span class="num">${storableProducts.length}</span> 种</span>` : ''}
    ${showConsumable ? `<span>零散货 <span class="num">${consumableProducts.length}</span> 种</span>` : ''}
    ${variant === 'all' ? `<span>合计 <span class="num">${allProducts.length}</span> 种</span>` : ''}
  </div>

<script>
  window.print();
<\/script>
</body>
</html>`
}
