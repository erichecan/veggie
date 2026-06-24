/**
 * 库存批次(Lot)FIFO 消耗/回补
 * ================================================================================
 * 权威库存余额 = Product.qtyOnHand(允许负数/超卖)。Lot.currentQty 记录每个已收批次
 * 的剩余量,供 FIFO 出库与效期预警使用。此前销售出库只扣 qtyOnHand 不扣 Lot,导致批次
 * 余量系统性虚高、效期报表不可信(见 docs/20260624-data-ownership-audit.md P1-5)。
 *
 * 用法:在任何销售/出库扣减 qtyOnHand 的同事务里调用 consumeLotsFIFO;撤回/回补时调用
 * restoreLotsFIFO。超卖(批次不足)时只扣到 0,差额由 qtyOnHand 负数体现,不臆造批次。
 */

// 接受 prisma client 或事务句柄(项目内多处用 prismaAny)
type LotClient = {
  lot: {
    findMany: (args: unknown) => Promise<Array<{ id: string; currentQty: unknown; initialQty: unknown }>>
    update: (args: unknown) => Promise<unknown>
  }
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

/** FIFO(最早 arrivedAt 优先)消耗批次余量。qty 为正数(要扣减的量)。 */
export async function consumeLotsFIFO(client: LotClient, productId: string, qty: number): Promise<void> {
  if (!(qty > 0)) return
  let remaining = qty
  const lots = await client.lot.findMany({
    where: { productId, status: 'AVAILABLE', currentQty: { gt: 0 } },
    orderBy: { arrivedAt: 'asc' },
  })
  for (const lot of lots) {
    if (remaining <= 0) break
    const take = Math.min(n(lot.currentQty), remaining)
    if (take <= 0) continue
    const depleted = n(lot.currentQty) - take <= 0
    await client.lot.update({
      where: { id: lot.id },
      data: { currentQty: { decrement: take }, ...(depleted ? { status: 'DEPLETED' } : {}) },
    })
    remaining -= take
  }
  // remaining > 0 → 超卖,无可扣批次;qtyOnHand 已记负,不补造批次
}

/** 回补批次余量(撤回/退货)。优先回补最近批次(newest first),不超过各批 initialQty 上限。 */
export async function restoreLotsFIFO(client: LotClient, productId: string, qty: number): Promise<void> {
  if (!(qty > 0)) return
  let remaining = qty
  const lots = await client.lot.findMany({
    where: { productId, status: { in: ['AVAILABLE', 'DEPLETED'] } },
    orderBy: { arrivedAt: 'desc' },
  })
  for (const lot of lots) {
    if (remaining <= 0) break
    const headroom = n(lot.initialQty) - n(lot.currentQty)
    if (headroom <= 0) continue
    const give = Math.min(headroom, remaining)
    await client.lot.update({
      where: { id: lot.id },
      data: { currentQty: { increment: give }, status: 'AVAILABLE' },
    })
    remaining -= give
  }
}
