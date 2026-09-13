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
 *
 */

import {
  type GoodsType,
  type TripPrintData,
  escapeHtml,
  formatTripDriverList,
  formatPrintTimestamp,
  renderTripNoticeHtml,
} from './trip-common'
import { sortLinesByUomSequence } from '@/lib/print/line-sort'
import { formatDateOnly } from '@/lib/format-date'
import { splitIntoPacks, type PackSpec } from '@/lib/pack-split'
import { displayUomName } from '@/lib/sale-uom'
import { formatUomConversionHint, type UomConversionInfo } from '@/lib/print/uom-conversion'
import type { PrintLang } from '@/lib/print/print-i18n'

const T = {
  zh: {
    docTitle: '拣货单',
    storableLabel: '整箱整袋 STOCKABLE',
    consumableLabel: '零散货 CONSUMABLE',
    deliveryDate: '配送日期：',
    driverBatch: '司机/批次：',
    customerCount: '客户数：',
    legend: '📦 <b>装货顺序</b>：1＝最下面（最重/最不怕压，最先装）……4＝最上面（最轻/最怕压，最后装）　"—"＝普通商品，未特意分层',
    colSeq: '#',
    colName: '商品名称',
    colQty: '总数量',
    colUom: '单位',
    colPack: '装货顺序',
    colCheck: '✓',
    unitCountSuffix: '种',
    hasNote: '⚠️ 有备注，见下方明细',
    statStorable: '整箱整袋',
    statConsumable: '零散货',
    statTotal: '合计',
  },
  en: {
    docTitle: 'Picking List',
    storableLabel: 'Full Case/Bag (STOCKABLE)',
    consumableLabel: 'Loose Goods (CONSUMABLE)',
    deliveryDate: 'Delivery Date:',
    driverBatch: 'Driver/Batch:',
    customerCount: 'Customers:',
    legend: '📦 <b>Load Order</b>: 1 = bottom (heaviest, loaded first) … 4 = top (most fragile, loaded last) — "—" = ordinary item, no tier set',
    colSeq: '#',
    colName: 'Product',
    colQty: 'Total Qty',
    colUom: 'Unit',
    colPack: 'Load Order',
    colCheck: '✓',
    unitCountSuffix: 'items',
    hasNote: '⚠️ Has note, see details below',
    statStorable: 'Full Case/Bag',
    statConsumable: 'Loose Goods',
    statTotal: 'Total',
  },
} as const

/** 组内多个单位装货顺序不一致时，取数字更大的那个（越大越后装/越靠上、越需要小心）——
 * 宁可保守多垫一层，也不要因为某个单位的顺序覆盖了另一个单位怕压的事实。
 * 一边没设置(null)时用另一边有值的那个，不让"没配置"意外压过一个明确设置的值。 */
function maxUomSequence(a: number | null, b: number | null): number | null {
  if (a == null) return b
  if (b == null) return a
  return a > b ? a : b
}

function fmtQty(v: number): string {
  if (v === Math.floor(v)) return String(v)
  return v.toFixed(2).replace(/0+$/, '').replace(/\.$/, '')
}

/** 装货顺序印在拣货单上的显示形式（20260912 改为 4 档）：0＝没特意分层的普通商品（多数商品都是
 *  这一档），不印"0"这个数字制造噪音；只有 1-4 这四个需要特殊摆放的档位才印出来醒目提示。 */
function fmtPackSeq(v: number | null): string {
  return v == null || v === 0 ? '—' : String(v)
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
  /** 商品 sequence，组内排序用（大货/散货的分组本身不变，见下方注释） */
  productSequence: number | null
  /** 装货顺序（20260907），排序用 */
  uomSequence: number | null
  spec: string
  uomName: string
  /** 箱规；行本身就是按大单位下的单时为 null（已经是整箱，不必再拆） */
  packSpec: PackSpec | null
  totalQty: number
  /** ProductTemplate.type: 'PRODUCT' | 'CONSU' | 'SERVICE' | null */
  productType: string | null
  /** 'LOOSE'(散称,按重量卖) 时按客户展示明细子行；'BULK'/null 只显示总量 */
  goodsType: GoodsType
  orderCodes: string[]
  byCustomer: Map<string, CustomerBreakdown>
  /** 这个单位自己的换算/毛重信息（20260911），同一 productId::uomId 恒定，取第一行的值即可 */
  uomConversion: UomConversionInfo | null
}

/**
 * 商品级分组（20260904）：同一商品在这一趟车里被不同订单用不同可售单位下单时
 * （比如一部分订单按 CASE、一部分按 EA），此前会拆成互不相干的两行平铺，拣货员
 * 看不出这俩其实是同一个商品。现在把 productId 相同的 AggProduct 收进一组：
 * 只有一个单位时按原样单行显示；多个单位时印一个父行（只显示商品名，20260909 起
 * 不再汇总/换算成基础单位）+ 每个单位各自一行子行（原始下单数量，拣货员照单位去拿）。
 */
interface ProductGroup {
  productId: string
  productName: string
  productSequence: number | null
  /** 组内各单位装货顺序取数字更大的那个，见 maxUomSequence */
  uomSequence: number | null
  spec: string
  productType: string | null
  uoms: AggProduct[]
}

export type PickingVariant = 'all' | 'storable' | 'consumable'

/**
 * 客户展开粒度（20260911 新增，对应"print"/"print multi line"两个打印口）：
 *   'auto' —— 默认。散称商品照旧强制按客户展开；非散称商品只把**带备注**的客户行
 *             单独摘出来，其余没备注的客户继续合并在主行总数里，不逐个列出
 *             （避免"一个客户有备注，其余几个客户也被迫展开"这种噪音）。
 *   'all'  —— 不管有没有备注/是否散称，每个商品都按客户逐行展开，给需要看清
 *             "这批货具体是哪几家、各多少"的场景（如司机自己核对、异常处理）。
 */
export type PickingExpandMode = 'auto' | 'all'

export function generateTripPickingHtml(
  data: TripPrintData,
  variant: PickingVariant = 'all',
  lang: PrintLang = 'zh',
  expandMode: PickingExpandMode = 'auto',
): string {
  const { trip, orders } = data
  const t = T[lang]

  // 拣货单是按商品汇总的整趟车视角,没有"每单一页"的粒度可退回订单级司机——筛选打印/
  // 全部打印横跨多个司机时,trip 级司机身份是空的,退回按订单 driverBatchLabel 去重列出。
  const teamStr = formatTripDriverList(trip, orders, lang)

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
          productSequence: line.productSequence ?? null,
          uomSequence: line.uomSequence ?? null,
          spec: line.spec ?? '',
          uomName: line.uomName ?? '',
          // 下单单位就是大单位时（如直接订 2 箱），数量本身已是整箱数，再按箱规拆
          // 会拆成「0 箱 + 2 箱」这种废话。只有按基准单位下单（订 30 包）才需要拆。
          packSpec: line.uomId && line.packSpec && line.uomName === line.packSpec.caseUomName
            ? null
            : (line.packSpec ?? null),
          totalQty: 0,
          productType: line.productType ?? null,
          goodsType: line.goodsType ?? null,
          orderCodes: [],
          byCustomer: new Map<string, CustomerBreakdown>(),
          uomConversion: line.uomConversion ?? null,
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

  /**
   * 表格归属判断（20260905 改）：不能只看 Product.type（实物/耗材的会计分类）——
   * "整箱整袋"这张表的字面意思是「按整箱/整袋卖」，哪怕商品本身是 Storable，
   * 只要这一单实际是按 Loose（散装/称重）单位卖的（Uom.goodsType==='LOOSE'），
   * 拣货员也得去"零散货"那张表找，不能指望它出现在整箱整袋表里。
   * CONSU 类型商品维持恒进零散货表。同一商品若在这一趟车里被不同订单分别按
   * 整箱、按散装两种单位下单，会按行拆开分别出现在两张表里——这是预期行为，
   * 不是重复/bug：拣货员应该按各自单位分别去两处找货。
   */
  function belongsToConsumableTable(p: AggProduct): boolean {
    return p.productType === 'CONSU' || p.goodsType === 'LOOSE'
  }

  function buildGroups(products: AggProduct[]): ProductGroup[] {
    const groupMap = new Map<string, ProductGroup>()
    for (const p of products) {
      let g = groupMap.get(p.productId)
      if (!g) {
        g = {
          productId: p.productId,
          productName: p.productName,
          productSequence: p.productSequence,
          uomSequence: p.uomSequence,
          spec: p.spec,
          productType: p.productType,
          uoms: [],
        }
        groupMap.set(p.productId, g)
      } else {
        g.uomSequence = maxUomSequence(g.uomSequence, p.uomSequence)
      }
      g.uoms.push(p)
    }
    return Array.from(groupMap.values())
  }

  // ⚠️ 大货/散货这个分组**不动** —— 那是仓库的作业顺序（先整箱后零散），
  // 2026-08-18 客户要的「按 sequence 排」、20260907 加的「按装货顺序排」都只改组内顺序，
  // 不该打乱仓库习惯。组内先按装货顺序（数字小的先装/在前，大的后装/在后），同层再按商品 sequence。
  const consumableGroups = sortLinesByUomSequence(buildGroups(allProducts.filter(belongsToConsumableTable)))
  const storableGroups = sortLinesByUomSequence(buildGroups(allProducts.filter(p => !belongsToConsumableTable(p))))
  const totalProductCount = new Set(allProducts.map(p => p.productId)).size

  const showStorable = variant !== 'consumable'
  const showConsumable = variant !== 'storable'
  const variantLabel =
    variant === 'storable' ? t.storableLabel
    : variant === 'consumable' ? t.consumableLabel
    : ''

  /**
   * 按客户展开的明细子行（散称/带备注商品）；`nested=true` 表示挂在「单位子行」下面，
   * 多缩进一级。`onlyNoted=true` 时只列带备注的客户，没备注的客户不占行——
   * 他们的数量已经算在主行总数里，不用再单独刷一行出来。
   */
  function customerBreakdownRows(byCustomer: Map<string, CustomerBreakdown>, nested: boolean, onlyNoted: boolean): string {
    return Array.from(byCustomer.values())
      .filter(bd => !onlyNoted || bd.note)
      .sort((a, b) => a.customerName.localeCompare(b.customerName))
      .map(bd => `
      <tr class="row-bd${nested ? ' row-bd-nested' : ''}">
        <td class="col-seq"></td>
        <td class="col-name bd-name">
          ↳ ${escapeHtml(bd.customerName)}
          ${bd.note ? `<span class="note-badge">⚠️ ${escapeHtml(bd.note)}</span>` : ''}
        </td>
        <td class="col-uom"></td>
        <td class="col-qty bd-qty">${fmtQty(bd.qty)}</td>
        <td class="col-pack"></td>
        <td class="col-check"></td>
      </tr>`).join('')
  }

  /** 这个聚合行（总量 qty）对应的毛重说明文字，如"毛重 ≈ 3.4kg"；没配毛重返回空串 */
  function grossWeightSpec(uomConversion: UomConversionInfo | null, qty: number): string {
    return formatUomConversionHint(uomConversion ?? undefined, qty)?.grossWeightLine ?? ''
  }

  /** 单一单位的商品行（组内只有一个可售单位时，跟改造前逐字一致） */
  function singleUomRow(p: AggProduct, seq: number, rowClass: string): string {
    const hasNote = Array.from(p.byCustomer.values()).some(bd => bd.note)
    const grossWeightText = grossWeightSpec(p.uomConversion, p.totalQty)
    const mainRow = `
      <tr class="${rowClass}">
        <td class="col-seq">${seq}</td>
        <td class="col-name">
          ${escapeHtml(p.productName)}
          ${p.spec ? `<span class="spec">${escapeHtml(p.spec)}</span>` : ''}
          ${grossWeightText ? `<span class="spec">${escapeHtml(grossWeightText)}</span>` : ''}
          ${hasNote ? `<span class="note-flag">${t.hasNote}</span>` : ''}
        </td>
        <td class="col-uom">${escapeHtml(displayUomName(p.uomName))}</td>
        <td class="col-qty">
          ${fmtQty(p.totalQty)}
          ${(() => {
            // 拆箱只在「确实要拆」时印：整除或不足一箱都没有额外信息量，
            // 多印一行反而挤占版面。splitIntoPacks 返回 null 表示不该拆。
            const sp = splitIntoPacks(p.totalQty, p.packSpec)
            return sp?.mixed ? `<span class="pack-split">${escapeHtml(sp.text)}</span>` : ''
          })()}
        </td>
        <td class="col-pack">${fmtPackSeq(p.uomSequence)}</td>
        <td class="col-check"></td>
      </tr>`
    const breakdownRows = pickBreakdownRows(p.byCustomer, p.goodsType, hasNote, false)
    return mainRow + breakdownRows
  }

  /**
   * 三处（单一单位行/多单位子行）共用的展开判断：
   *   expandMode='all' —— 不管什么情况，全部客户都列出来；
   *   expandMode='auto' —— 散称维持全展开（业务需要称重核对，不受本次改动影响），
   *     非散称只有在有备注时才展开，且只列带备注的客户（onlyNoted=true）。
   */
  function pickBreakdownRows(byCustomer: Map<string, CustomerBreakdown>, goodsType: GoodsType, hasNote: boolean, nested: boolean): string {
    if (expandMode === 'all') return customerBreakdownRows(byCustomer, nested, false)
    if (goodsType === 'LOOSE') return customerBreakdownRows(byCustomer, nested, false)
    if (hasNote) return customerBreakdownRows(byCustomer, nested, true)
    return ''
  }

  /**
   * 同一商品挂了多个可售单位时的两层行：父行（只印商品名，不再汇总/换算成基础单位）+
   * 每个单位各自一行子行（原始下单数量，拣货员照单位去拿——每行数量本身就是准确的，
   * 不需要再额外标注"等于多少基础单位"）。
   * 父行的「数量/单位/装货顺序」都留空——它不对应某个具体要拿的数量或要放的物理位置，
   * 真正要看的数字在下面每个单位子行各自的值上。
   */
  function multiUomRows(g: ProductGroup, seq: number, rowClass: string): string {
    const hasNote = g.uoms.some(u => Array.from(u.byCustomer.values()).some(bd => bd.note))
    const parentRow = `
      <tr class="${rowClass} row-group-parent">
        <td class="col-seq">${seq}</td>
        <td class="col-name">
          ${escapeHtml(g.productName)}
          ${g.spec ? `<span class="spec">${escapeHtml(g.spec)}</span>` : ''}
          ${hasNote ? `<span class="note-flag">${t.hasNote}</span>` : ''}
        </td>
        <td class="col-uom"></td>
        <td class="col-qty"></td>
        <td class="col-pack"></td>
        <td class="col-check"></td>
      </tr>`
    const childRows = g.uoms.map(u => {
      const uHasNote = Array.from(u.byCustomer.values()).some(bd => bd.note)
      const uGrossWeightText = grossWeightSpec(u.uomConversion, u.totalQty)
      const childRow = `
      <tr class="row-uom-child">
        <td class="col-seq"></td>
        <td class="col-name bd-name">
          ↳${uGrossWeightText ? ` <span class="spec">${escapeHtml(uGrossWeightText)}</span>` : ''}${uHasNote ? ` <span class="note-flag">${t.hasNote}</span>` : ''}
        </td>
        <td class="col-uom">${escapeHtml(displayUomName(u.uomName))}</td>
        <td class="col-qty bd-qty">
          ${fmtQty(u.totalQty)}
          ${(() => {
            const sp = splitIntoPacks(u.totalQty, u.packSpec)
            return sp?.mixed ? `<span class="pack-split">${escapeHtml(sp.text)}</span>` : ''
          })()}
        </td>
        <td class="col-pack">${fmtPackSeq(u.uomSequence)}</td>
        <td class="col-check"></td>
      </tr>`
      const breakdownRows = pickBreakdownRows(u.byCustomer, u.goodsType, uHasNote, true)
      return childRow + breakdownRows
    }).join('')
    return parentRow + childRows
  }

  function productTableHtml(title: string, groups: ProductGroup[], icon: string, startNewPage = false): string {
    if (groups.length === 0) return ''
    const rows = groups.map((g, i) => {
      const rowClass = i % 2 === 0 ? 'row-even' : 'row-odd'
      return g.uoms.length === 1 ? singleUomRow(g.uoms[0], i + 1, rowClass) : multiUomRows(g, i + 1, rowClass)
    }).join('')

    return `
    <div class="section-header${startNewPage ? ' section-2nd' : ''}">${icon} ${escapeHtml(title)}（${groups.length} ${t.unitCountSuffix}）</div>
    <table class="pick-table">
      <thead>
        <tr>
          <th class="col-seq">${t.colSeq}</th>
          <th class="col-name">${t.colName}</th>
          <th class="col-uom">${t.colUom}</th>
          <th class="col-qty">${t.colQty}</th>
          <th class="col-pack">${t.colPack}</th>
          <th class="col-check">${t.colCheck}</th>
        </tr>
      </thead>
      <tbody>${rows}</tbody>
    </table>`
  }

  return `<!doctype html>
<html lang="zh">
<head>
<meta charset="utf-8"/>
<title>${t.docTitle}${variantLabel ? ' · ' + escapeHtml(variantLabel) : ''} — ${escapeHtml(teamStr)}</title>
<style>
  *,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
  html,body{font-family:Arial,Helvetica,"Noto Sans CJK SC","Noto Sans SC",sans-serif;font-size:11px;color:#000;background:#fff}
  body{padding:14px 20px}

  .page-header{margin-bottom:6px;padding-bottom:6px;border-bottom:2px solid #1a3a2a}
  .page-header .print-at{font-size:10px;color:#333}

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
  /* 拆箱副标：印在总数量下面一行，比总数小一号，仓库先看总数再看怎么拿 */
  .pack-split{display:block;font-weight:600;font-size:10px;color:#1a5c2e;white-space:nowrap;margin-top:1px}
  .col-uom{width:80px;text-align:center;color:#555}
  /* 装货顺序：数字越小越先装/放最下，越大越后装/放最上——具体解释印在 .pack-legend 里，
     不在每行重复文字，列本身只放数字，保持表格紧凑 */
  .col-pack{width:60px;text-align:center;font-weight:700;color:#1a3a2a}
  .col-check{width:40px;text-align:center;border:1px solid #ccc!important}

  .pack-legend{margin-bottom:10px;padding:5px 8px;font-size:10px;color:#555;background:#fff8e6;border:1px solid #f0d98c;border-radius:4px}
  .pack-legend b{color:#1a3a2a}

  .spec{display:block;font-size:9px;color:#888;margin-top:1px}
  .note-flag{display:inline-block;margin-left:6px;padding:1px 6px;border-radius:3px;font-size:9px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #f59e0b;vertical-align:middle}
  .note-badge{display:inline-block;margin-left:8px;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:700;background:#fef3c7;color:#92400e;border:1px solid #f59e0b}

  tr.row-bd td{border-bottom:1px dashed #e0e0e0;padding-top:2px;padding-bottom:2px}
  .bd-name{padding-left:26px!important;color:#555;font-size:10px}
  .bd-qty{font-weight:600!important;font-size:11px!important;color:#555}
  /* 客户明细子行挂在「单位子行」下面时，多缩进一级，跟单位子行分层看得出来 */
  tr.row-bd-nested .bd-name{padding-left:40px!important}

  /* 一个商品挂了多个可售单位时：父行只显示商品名（数量/单位留空），子行=各单位原始下单数量 */
  tr.row-group-parent td{font-weight:700;background:#eef5f0!important}
  tr.row-uom-child td{border-bottom:1px dashed #e0e0e0;padding-top:2px;padding-bottom:2px}
  tr.row-uom-child .bd-name{padding-left:26px!important;color:#555;font-size:11px;font-weight:700}

  .stats{margin-top:12px;font-size:10px;color:#555;display:flex;gap:16px}
  .stats .num{font-weight:700;color:#000}

  @media print{
    body{padding:0}
    @page{margin:10mm 8mm}

    /* 分页控制（20260811 补）：此前只设了页边距，多页拣货单会
       ①行被拦腰截断 ②第二页起没有表头，仓库不知道哪列是数量。 */

    /* 表头在每一页重复 —— thead 的这个值就是给分页用的 */
    .pick-table thead{display:table-header-group}
    /* 一行不许跨页断开：数量和商品名被切到两页上会拣错 */
    .pick-table tr{break-inside:avoid;page-break-inside:avoid}
    /* ⛔ 20260824 移除了 .pick-table tr:not(.row-bd){break-after:avoid}——
       意图是"商品主行别跟丢在页底的客户明细子行分开"，但对几十行的长表格逐行都设
       break-after:avoid 会触发无头 Chromium page.pdf() 的一个已知分页缺陷：只要最早
       出现的一处"避让"约束在页面很靠前的位置生效（比如第 2 行商品就带了客户明细子行），
       它就会把该约束之后的所有内容整体推到下一页，而不是继续往当前页填——实测一张
       35 行、页 1 本该能装下 30+ 行的拣货单，被这条规则挤到只剩 2 行，下一页塞 33 行。
       row 自身仍有 break-inside:avoid 兜底（单行不会被从中间切断），孤儿主行这种更轻的
       瑕疵可以接受，好过页面几乎打空。*/
    /* 区块标题不许单独留在页底 */
    .section-header{break-after:avoid;page-break-after:avoid}
    /* 整箱整袋 / 零散货 各自起新页：两批货由不同的人在不同区域拣 */
    .section-header.section-2nd{break-before:page;page-break-before:always}
  }
</style>
</head>
<body>
  <div class="page-header">
    <div class="print-at">Print at: ${formatPrintTimestamp()}</div>
  </div>

  ${renderTripNoticeHtml(trip.notice)}

  <div class="info-row">
    <div class="item"><span class="label">${t.deliveryDate}</span>${dateStr}</div>
    <div class="item"><span class="label">${t.driverBatch}</span>${escapeHtml(teamStr)}</div>
    <div class="item"><span class="label">${t.customerCount}</span>${new Set(orders.map(o => o.customerId)).size}</div>
  </div>

  <div class="pack-legend">${t.legend}</div>

  ${showStorable ? productTableHtml(t.storableLabel, storableGroups, '📦') : ''}
  ${showConsumable ? productTableHtml(t.consumableLabel, consumableGroups, '🧴', showStorable && storableGroups.length > 0) : ''}

  <div class="stats">
    ${showStorable ? `<span>${t.statStorable} <span class="num">${storableGroups.length}</span> ${t.unitCountSuffix}</span>` : ''}
    ${showConsumable ? `<span>${t.statConsumable} <span class="num">${consumableGroups.length}</span> ${t.unitCountSuffix}</span>` : ''}
    ${variant === 'all' ? `<span>${t.statTotal} <span class="num">${totalProductCount}</span> ${t.unitCountSuffix}</span>` : ''}
  </div>

<script>
  window.print();
<\/script>
</body>
</html>`
}
