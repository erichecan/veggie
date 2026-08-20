import { factorOf } from '@/lib/sale-uom'

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
    findMany: (args: unknown) => Promise<Array<{ id: string; lotNumber: string; currentQty: unknown; initialQty: unknown }>>
    update: (args: unknown) => Promise<unknown>
  }
}

/** 消耗/回补落到了哪些批次，供调用方把 StockMove.lotId 精确记到批次级别（批次追溯的数据基础） */
export interface LotMovement {
  lotId: string
  lotNumber: string
  qty: number
}

const n = (v: unknown): number => (typeof v === 'number' ? v : Number(v ?? 0)) || 0

// 多单位销售(ProductSaleUom)换算用的最小 client 形状
type StockQtyClient = {
  productSaleUom: {
    findMany: (args: unknown) => Promise<Array<{ uomId: string; isDefault: boolean; factor: unknown }>>
  }
}

/**
 * 多单位销售换算：把订单行选用单位的数量，换算成**基础单位**的数量。
 *
 * 基础单位 = 该商品 `ProductSaleUom` 里 `isDefault` 那一行，`Product.qtyOnHand`
 * 与 `Lot.currentQty` 都按它计数（客户 20260819 拍板：库存记最小单位）。
 * 换算系数取 `ProductSaleUom.factor`，即「1 个此单位 = factor 个基础单位」。
 *
 * ⛔ 20260819 之前这里读的是全局 `Uom.factor`，那是错的：
 * `10*700g CASE`（一箱 10 包）与 `30*62g CASE`（一箱 30 包）在生产库里都叫 CASE，
 * 而 Unit 类目下的全局 factor 干脆全是 1 —— 于是卖一整箱只扣一个基础单位，
 * 库存系统性虚高。系数是**商品**的属性，不是单位的属性。
 *
 * 没配多规格的商品（生产库 5474 / 5476 个）原样返回 qty，
 * 与多单位功能上线前逐字一致，不影响任何存量数据。
 */
export async function toStockQty(
  client: StockQtyClient,
  productId: string,
  qty: number,
  lineUomId: string | null | undefined,
): Promise<number> {
  if (!lineUomId || qty === 0) return qty
  const rows = await client.productSaleUom.findMany({
    where: { productId, active: true },
    select: { uomId: true, isDefault: true, factor: true },
  })
  if (!rows || rows.length === 0) return qty
  const normalized = rows.map(r => ({
    uomId: r.uomId,
    isDefault: r.isDefault,
    factor: n(r.factor) || 1,
    priceOverride: null,
  }))
  return qty * factorOf(normalized, lineUomId)
}

/** FIFO(最早 arrivedAt 优先)消耗批次余量。qty 为正数(要扣减的量)。返回实际消耗的批次明细。 */
export async function consumeLotsFIFO(client: LotClient, productId: string, qty: number): Promise<LotMovement[]> {
  if (!(qty > 0)) return []
  let remaining = qty
  const consumed: LotMovement[] = []
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
    consumed.push({ lotId: lot.id, lotNumber: lot.lotNumber, qty: take })
    remaining -= take
  }
  // remaining > 0 → 超卖,无可扣批次;qtyOnHand 已记负,不补造批次
  return consumed
}

/** 回补批次余量(撤回/退货)。优先回补最近批次(newest first),不超过各批 initialQty 上限。返回实际回补的批次明细。 */
export async function restoreLotsFIFO(client: LotClient, productId: string, qty: number): Promise<LotMovement[]> {
  if (!(qty > 0)) return []
  let remaining = qty
  const restored: LotMovement[] = []
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
    restored.push({ lotId: lot.id, lotNumber: lot.lotNumber, qty: give })
    remaining -= give
  }
  return restored
}
