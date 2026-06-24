import type { OrderItem } from './types'

/**
 * 订单明细统一读取口(SSOT)
 * ================================================================================
 * 唯一权威 = OrderLine 表。Order.items(Json)是纯派生投影,只在 API 出口由 lines
 * 实时生成,任何读取方都不应再信任 Order.items 列的存量值(它在改单/差异/送达/开票后
 * 会腐化)。详见 docs/20260624-data-ownership-audit.md(P0-3)。
 *
 * 用法:在所有返回订单给前端的 GET 端点,先 serializeApi(把 Decimal 转 number),
 * 再 deriveOrderItems(用 lines 覆盖 items)。
 */

/** OrderLine(已 serializeApi,Decimal 已转 number)→ 旧 OrderItem JSON 结构 */
type LineLike = {
  productId: string
  productName: string
  spec?: string | null
  note?: string | null
  unitPrice?: number | string | null
  taxRate?: number | string | null
  orderedQty?: number | string | null
  deliveredQty?: number | string | null
  invoicedQty?: number | string | null
  subtotal?: number | string | null
  uomId?: string | null
  uomName?: string | null
}

const num = (v: unknown): number => {
  if (typeof v === 'number') return v
  if (v == null) return 0
  const n = Number(v)
  return Number.isFinite(n) ? n : 0
}

export function lineToOrderItem(l: LineLike): OrderItem {
  return {
    productId: l.productId,
    productName: l.productName,
    spec: l.spec ?? '',
    note: l.note ?? undefined,
    price: num(l.unitPrice),
    quantity: num(l.orderedQty),
    subtotal: num(l.subtotal),
    uomId: l.uomId ?? undefined,
    uomName: l.uomName ?? undefined,
    taxRate: l.taxRate == null ? undefined : num(l.taxRate),
    deliveredQty: num(l.deliveredQty),
    invoicedQty: num(l.invoicedQty),
  }
}

export function orderItemsFromLines(lines: LineLike[]): OrderItem[] {
  return lines.map(lineToOrderItem)
}

/**
 * 把单个订单对象的 items 覆盖为 lines 的实时投影。
 * - 有 lines → items 一律由 lines 派生(权威)
 * - 无 lines(历史/遗留订单,只有旧 items 列没有行记录)→ 保留原 items 兜底
 * 非订单对象 / 无 lines 字段 → 原样返回。
 */
export function deriveOrderItems<T extends { lines?: unknown; items?: unknown }>(order: T): T {
  if (!order || typeof order !== 'object') return order
  const lines = (order as { lines?: unknown }).lines
  if (Array.isArray(lines) && lines.length > 0) {
    return { ...order, items: orderItemsFromLines(lines as LineLike[]) }
  }
  return order
}

/** 列表场景:对订单数组逐个派生 items */
export function deriveOrderItemsList<T extends { lines?: unknown; items?: unknown }>(orders: T[]): T[] {
  return orders.map(deriveOrderItems)
}
