/**
 * 订单 ↔ 库存对账 —— 20261014（复式改造 L3）
 * ============================================================================
 * 以前订单的库存联动散在 6 处（确认、整单改行、改单行、撤回、取消、批量确认/取消），每处按
 * 「orderedQty 的增减」盲目加减库存。于是：
 *   - Place Order 页的「确认」直接 POST 成 CONFIRMED，根本没走扣库存那段 → 库存不动；
 *   - 这种从没扣过的单，之后取消/撤回/减量又按 orderedQty「释放」→ 凭空多出库存；
 *   - 取消时只加 qtyOnHand 不回补批次，批次余量与总数分叉。
 *
 * 现在只有一条规则：**订单应占用的库存 = 目标，流水里这张单已经拿走的 = 已拿，差多少补多少**。
 *   目标：状态在 CONFIRMED / WAVE_ASSIGNED / IN_DELIVERY → Σ 各实物行 orderedQty（换算成基础单位）；
 *         PENDING（报价）/ CANCELLED → 0。
 *   已拿：Σ 流水（sourceType ORDER/SO、sourceId = 订单）—— 见 takenBySource。
 * 任何改了订单状态或行的地方，改完调一次 syncOrderStock；重复调用没有副作用（幂等）。
 *
 * COMPLETED / LOCKED 的单默认不动（货已经送出去了）；差异处理等送达后改行的场景传 allowCompleted，
 * 但只对**有过流水**的单生效——Odoo 导入的历史单从没有流水，不能因为改了一行就补扣全部（D1：历史不补）。
 */
import { toStockQty } from '@/lib/inventory'
import { postStockMove, takenBySource, LOC } from '@/lib/stock-ledger'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

export const ORDER_STOCK_SOURCE_TYPES = ['ORDER', 'SO']
export const ORDER_RESERVED_STATUSES: ReadonlySet<string> = new Set(['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY'])
const ORDER_DONE_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'LOCKED'])

const r3 = (v: number) => Math.round(v * 1000) / 1000

export interface OrderStockSyncResult {
  changed: Array<{ productId: string; delta: number }>
  skipped?: 'completed' | 'legacy'
}

export async function syncOrderStock(
  tx: Tx,
  orderId: string,
  opts: { reason?: string; movedAt?: Date; userId?: string | null; createdBy?: string | null; allowCompleted?: boolean } = {},
): Promise<OrderStockSyncResult> {
  const order = await tx.order.findUnique({
    where: { id: orderId },
    select: { id: true, code: true, status: true, restaurantId: true, deliveryDate: true },
  })
  if (!order) return { changed: [] }
  const status = String(order.status).toUpperCase()
  const taken = await takenBySource(tx, ORDER_STOCK_SOURCE_TYPES, orderId)

  if (ORDER_DONE_STATUSES.has(status)) {
    if (!opts.allowCompleted) return { changed: [], skipped: 'completed' }
    if (taken.size === 0) return { changed: [], skipped: 'legacy' }
  }

  const lines: Array<{ id: string; productId: string; productName: string | null; orderedQty: unknown; uomId: string | null; uomName?: string | null; product: { type: string } | null }> =
    await tx.orderLine.findMany({
      where: { orderId },
      select: { id: true, productId: true, productName: true, orderedQty: true, uomId: true, product: { select: { type: true } } },
      orderBy: { id: 'asc' },
    })

  const reserve = ORDER_RESERVED_STATUSES.has(status) || ORDER_DONE_STATUSES.has(status)
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
  const movedAt = opts.movedAt ?? order.deliveryDate ?? new Date()
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
      note: `订单 ${ref} ${opts.reason ?? (outbound ? '占用库存' : '释放库存')}（${status}）`,
      createdBy: opts.createdBy ?? null,
      userId: opts.userId ?? null,
    })
    changed.push({ productId, delta })
  }
  return { changed }
}

/**
 * 未送达订单里**还没从库存扣走**的需求（基础单位），按商品汇总。
 * ⛔ 缺货、补货建议、预测都要用它，而不是直接 Σ orderedQty：已确认订单在确认时已经从
 * qtyOnHand 扣掉了，再按 orderedQty 减一次就是重复扣减（20261014 排查 Forecast 时发现
 * 波次缺货、采购建议两处同样中招：库存 100、确认 60 → 在手 40，却报「缺 20」）。
 * 正常情况下这里全是 0；只有改造前绕过确认扣减建成 CONFIRMED 的单会有值。
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
