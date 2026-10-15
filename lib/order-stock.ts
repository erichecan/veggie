/**
 * 订单 ↔ 库存对账 —— 20261014（复式改造 L3）
 * ============================================================================
 * 以前订单的库存联动散在 6 处（确认、整单改行、改单行、撤回、取消、批量确认/取消），每处按
 * 「orderedQty 的增减」盲目加减库存。于是：
 *   - Place Order 页的「确认」直接 POST 成 CONFIRMED，根本没走扣库存那段 → 库存不动；
 *   - 这种从没扣过的单，之后取消/撤回/减量又按 orderedQty「释放」→ 凭空多出库存；
 *   - 取消时只加 qtyOnHand 不回补批次，批次余量与总数分叉。
 *
 * 现在只有一条规则：**订单应从仓库拿走的量 = 目标，流水里这张单已经拿走的 = 已拿，差多少补多少**。
 *   目标：货已经出库（IN_DELIVERY 确认出发 / COMPLETED / LOCKED）→ Σ 各实物行 orderedQty（换算成基础单位）；
 *         其余（PENDING 报价、CONFIRMED / WAVE_ASSIGNED 已确认待出库、CANCELLED）→ 0。
 *   已拿：Σ 流水（sourceType ORDER/SO、sourceId = 订单）—— 见 takenBySource。
 * 任何改了订单状态或行的地方，改完调一次 syncOrderStock；重复调用没有副作用（幂等）。
 *
 * ⛔ 20261015 起出库时点与采购对称（客户：「purchase 流程是对的，可以参考」，即 Odoo 口径）：
 *   采购：确认 → Forecast 增加，On Hand 不变；收货 → On Hand 增加。
 *   销售：确认 → Forecast 减少（未出库需求，见 untakenOrderDemand），On Hand 不变；
 *         确认出发 / 完成（货离仓）→ On Hand 减少，Forecast 不再变。
 *   20261014 版本是「确认即扣 On Hand」，那期间确认、还没出发的单流水里已经拿过库存；它们被再次同步时
 *   （改行、撤回、出发……）会先按目标 0 还回去，出发时再扣，最终一致。
 *
 * 历史保护（D1：历史不补）：已出库状态的单如果流水里从没拿过，只有在**本次就是出库动作**（opts.shipping）
 * 时才补扣；否则视为 Odoo 导入的历史单，不因为改了一行就补扣全部。
 */
import { toStockQty } from '@/lib/inventory'
import { postStockMove, takenBySource, LOC } from '@/lib/stock-ledger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

export const ORDER_STOCK_SOURCE_TYPES = ['ORDER', 'SO']
/** 已确认、尚未完成的单：它们的需求要么还没出库（计入 Forecast 的「待出库」），要么正在配送 */
export const ORDER_RESERVED_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
/** 货已经离仓：从仓库扣走 On Hand 的状态 */
export const ORDER_SHIPPED_STATUSES: ReadonlySet<string> = new Set(['IN_DELIVERY', 'COMPLETED', 'LOCKED'])

const r3 = (v: number) => Math.round(v * 1000) / 1000

export interface OrderStockSyncResult {
  changed: Array<{ productId: string; delta: number }>
  skipped?: 'legacy'
}

export async function syncOrderStock(
  tx: Tx,
  orderId: string,
  opts: {
    reason?: string; movedAt?: Date; userId?: string | null; createdBy?: string | null
    /** 本次调用就是出库动作（确认出发 / 完成 / 批量开始配送），历史单也要扣 */
    shipping?: boolean
    /** @deprecated 20261015 起不再需要，保留参数兼容旧调用 */
    allowCompleted?: boolean
  } = {},
): Promise<OrderStockSyncResult> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, code: true, status: true, restaurantId: true, deliveryDate: true },
  })
  if (!order) return { changed: [] }
  const status = String(order.status).toUpperCase()
  const taken = await takenBySource(tx, ORDER_STOCK_SOURCE_TYPES, orderId)

  const shipped = ORDER_SHIPPED_STATUSES.has(status)
  if (shipped && taken.size === 0 && !opts.shipping) return { changed: [], skipped: 'legacy' }

  const lines: Array<{ id: string; productId: string; productName: string | null; orderedQty: unknown; uomId: string | null; uomName?: string | null; product: { type: string } | null }> =
    await tx.orderLine.findMany({
      where: { orderId },
      select: { id: true, productId: true, productName: true, orderedQty: true, uomId: true, product: { select: { type: true } } },
      orderBy: { id: 'asc' },
    })

  const reserve = shipped
  const target = new Map<string, number>()
  const lineOf = new Map<string, { id: string; name: string; uomQty: number; uomId: string | null }>()
  if (reserve) {
    for (const l of lines) {
      if (!l.product || l.product.type !== 'PRODUCT') continue
      const q = Number(l.orderedQty ?? 0)
      if (!(q > 0)) continue
      const stockQty = await toStockQty(tx, l.productId, q, l.uomId)
      target.set(l.productId, r3((target.get(l.productId) ?? 0) + stockQty))
      if (!lineOf.has(l.productId)) lineOf.set(l.productId, { id: l.id, name: l.productName ?? '', uomQty: q, uomId: l.uomId })
    }
  }

  const ref = order.code ?? orderId
  // 出库流水记实际发生时间（货离仓那一刻），不是计划交货日
  const movedAt = opts.movedAt ?? new Date()
  const changed: OrderStockSyncResult['changed'] = []
  for (const productId of new Set([...target.keys(), ...taken.keys()])) {
    const delta = r3((target.get(productId) ?? 0) - (taken.get(productId) ?? 0))
    if (Math.abs(delta) < 0.0005) continue
    const line = lineOf.get(productId)
    const outbound = delta > 0
    await postStockMove(tx, {
      productId,
      productName: line?.name,
      qty: Math.abs(delta),
      from: outbound ? LOC.STOCK : LOC.CUSTOMERS,
      to: outbound ? LOC.CUSTOMERS : LOC.STOCK,
      type: outbound ? 'OUT' : 'IN',
      lot: { mode: 'fefo' },
      sourceType: 'ORDER',
      sourceId: orderId,
      sourceRef: ref,
      orderLineId: line?.id ?? null,
      partnerId: order.restaurantId,
      movedAt,
      note: `订单 ${ref} ${opts.reason ?? (outbound ? '出库' : '退回仓库')}（${status}）`,
      createdBy: opts.createdBy ?? null,
      userId: opts.userId ?? null,
    })
    changed.push({ productId, delta })
  }
  return { changed }
}

/**
 * 已确认、还没从仓库出库的需求（基础单位），按商品汇总 = Forecast 里的「待出库」。
 * = Σ 各未完成订单（目标需求 − 流水里已拿走）。20261015 起确认不扣 On Hand，已确认待出库的单
 * 这里就是它的全部需求；正在配送的单已出库，这里为 0。按「目标 − 已拿」算而不是直接 Σ orderedQty，
 * 是为了兼容 20261014 那一天「确认即扣」留下的流水，任何时候都不重复扣减。
 *   缺货量 = max(0, untaken − qtyOnHand)（qtyOnHand 为负 = 已超卖，同样计入）
 */
export async function untakenOrderDemand(
  db: Tx,
  productIds: string[],
  orderWhere: Record<string, unknown> = {},
): Promise<Map<string, number>> {
  const out = new Map<string, number>()
  if (productIds.length === 0) return out
  const lines: Array<{ orderId: string; productId: string; orderedQty: unknown; uomId: string | null }> = await db.orderLine.findMany({
    where: {
      productId: { in: productIds },
      product: { type: 'PRODUCT' },
      order: { status: { in: [...ORDER_RESERVED_STATUSES] }, ...orderWhere },
    },
    select: { orderId: true, productId: true, orderedQty: true, uomId: true },
  })
  const target = new Map<string, number>()
  for (const l of lines) {
    const q = Number(l.orderedQty ?? 0)
    if (!(q > 0)) continue
    const k = `${l.orderId}|${l.productId}`
    target.set(k, (target.get(k) ?? 0) + await toStockQty(db, l.productId, q, l.uomId))
  }
  if (target.size === 0) return out
  const orderIds = [...new Set(lines.map(l => l.orderId))]
  const rows: Array<{ sourceId: string; productId: string; _sum: { qty: unknown } }> = await db.stockMove.groupBy({
    by: ['sourceId', 'productId'],
    where: { sourceType: { in: ORDER_STOCK_SOURCE_TYPES }, sourceId: { in: orderIds }, productId: { in: productIds } },
    _sum: { qty: true },
  })
  const taken = new Map(rows.map(r => [`${r.sourceId}|${r.productId}`, -Number(r._sum.qty ?? 0)]))
  for (const [k, t] of target) {
    const rest = t - Math.max(0, taken.get(k) ?? 0)
    if (rest > 0.0005) {
      const pid = k.split('|')[1]
      out.set(pid, r3((out.get(pid) ?? 0) + rest))
    }
  }
  return out
}
