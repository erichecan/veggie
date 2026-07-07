import type { OrderItem } from './types'
import type { Prisma, PrismaClient } from './generated/prisma/client'
import { serializeApi } from './api-serializer'

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
  commissionPrice?: number | string | null
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
    commissionPrice: l.commissionPrice == null ? undefined : num(l.commissionPrice),
  }
}

export function orderItemsFromLines(lines: LineLike[]): OrderItem[] {
  return lines.map(lineToOrderItem)
}

/**
 * 订单含税总额(税后)= Σ 行税前 subtotal ×(1+taxRate)。
 * Order.totalAmount 是税前(SSOT,见 docs/20260701 A-2)；对账/财务「销售额」需税后展示，
 * 在读取出口实时派生,不新增存储副本。taxRate 已订正为百分数(23),此处 >1 归一双保险。
 */
export function orderIncTaxTotal(lines: Array<{ subtotal?: unknown; taxRate?: unknown }>): number {
  const t = lines.reduce((s, l) => {
    const sub = num(l.subtotal)
    const tr = num(l.taxRate)
    const frac = tr > 1 ? tr / 100 : tr
    return s + sub * (1 + frac)
  }, 0)
  return Math.round(t * 100) / 100
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
    return {
      ...order,
      items: orderItemsFromLines(lines as LineLike[]),
      // 税后总额(派生,B-1):财务/对账「销售额」用此字段,不动税前的 totalAmount(SSOT)
      totalAmountIncTax: orderIncTaxTotal(lines as LineLike[]),
    } as T
  }
  // 无行的历史订单兜底:含税额退回存量 totalAmount
  return { ...order, totalAmountIncTax: num((order as { totalAmount?: unknown }).totalAmount) } as T
}

/** 列表场景:对订单数组逐个派生 items */
export function deriveOrderItemsList<T extends { lines?: unknown; items?: unknown }>(orders: T[]): T[] {
  return orders.map(deriveOrderItems)
}

type OrderItemsDbClient = Prisma.TransactionClient | PrismaClient

/**
 * 从库中读该订单当前 OrderLine,生成 items 快照(不写回)。
 * PUT 主改单把它塞进既有 updateData 一并写;shortage/apply 走 syncOrderItemsSnapshot。
 */
export async function buildOrderItemsSnapshot(db: OrderItemsDbClient, orderId: string): Promise<OrderItem[]> {
  const lines = await db.orderLine.findMany({ where: { orderId }, orderBy: { sequence: 'asc' } })
  return orderItemsFromLines(serializeApi(lines) as unknown as Parameters<typeof orderItemsFromLines>[0])
}

/**
 * 回写 Order.items 派生快照。凡在写入端改动了 OrderLine(增/删/改数量),都应在同一事务内调用,
 * 把 items 列同步为 lines 的当前投影——避免下游 waves/trips/dispatch 等直接读 items 列的端点
 * (尚未落地 deriveOrderItems)吃到旧数量。本函数是「items 双存」现实下的一致性兜底,
 * 待下游读取端全部改 derive 后可移除。见本文件头 SSOT 说明。
 */
export async function syncOrderItemsSnapshot(db: OrderItemsDbClient, orderId: string): Promise<void> {
  const items = await buildOrderItemsSnapshot(db, orderId)
  await db.order.update({ where: { id: orderId }, data: { items: items as unknown as object } })
}
