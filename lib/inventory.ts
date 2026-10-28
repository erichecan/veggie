import { factorOf } from '@/lib/sale-uom'

/**
 * 库存批次(Lot)FEFO 消耗 / 回补
 * ================================================================================
 * 权威库存余额 = Product.qtyOnHand(允许负数/超卖)。Lot.currentQty 记录每个已收批次
 * 的剩余量,供出库消耗与效期预警使用。此前销售出库只扣 qtyOnHand 不扣 Lot,导致批次
 * 余量系统性虚高、效期报表不可信(见 docs/20260624-data-ownership-audit.md P1-5)。
 *
 * ⛔ 20261003 改动:消耗顺序从「到货日期(arrivedAt)先后」改成「保质期(bestBefore)
 * 早晚」——到货早不等于保质期短(供应商那边压货久的批次会出现"后到但先过期")，
 * 按到货日期扣等于没有真正保证"先过期的先出"，客户反馈怀疑仓库发货顺序跟系统批次
 * 逻辑对不上，根子就在这里：系统自己的自动扣减就没有严格按保质期。函数名仍叫
 * `consumeLotsFIFO`/`restoreLotsFIFO` 没有改——真正的语义已经是 FEFO
 * (First-Expired-First-Out)，但两个函数有 7 处调用点，纯改名不值得为了措辞精确
 * 牵一发动全身，这段注释就是给后来者的准确说明。没有 bestBefore 的批次排在最后，
 * 退化为按到货日期（行为与改动前对这些批次完全一致）。
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
// 方法签名（非箭头函数属性）故意用方法写法：TS 对方法参数是双变检查，箭头函数属性是
// 逆变检查——用箭头写法会导致真实 Prisma.TransactionClient 的 findMany（参数类型
// 比 unknown 更窄）传不进来（20261027 lib/returns-engine.ts 把 tx 从 any 改成
// Prisma.TransactionClient 后在这里炸出来，不是新引入的问题，是把 any 的漏检显形了）
type StockQtyClient = {
  productSaleUom: {
    findMany(args: unknown): Promise<Array<{ uomId: string; isDefault: boolean; factor: unknown }>>
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

/** FEFO(最早 bestBefore 优先，无保质期的排最后按 arrivedAt)消耗批次余量。qty 为正数(要扣减的量)。返回实际消耗的批次明细。 */
export async function consumeLotsFIFO(client: LotClient, productId: string, qty: number): Promise<LotMovement[]> {
  if (!(qty > 0)) return []
  let remaining = qty
  const consumed: LotMovement[] = []
  const lots = await client.lot.findMany({
    where: { productId, status: 'AVAILABLE', currentQty: { gt: 0 } },
    orderBy: [{ bestBefore: { sort: 'asc', nulls: 'last' } }, { arrivedAt: 'asc' }],
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

/**
 * 先扣指定批次（按 preferLotIds 的顺序），不够再按 FEFO 扣其余批次。
 * 采购退货用（20261022 客户：「50 箱误收成 500 箱进了 LOT-01106，退 450 箱应该从 LOT-01106 退，
 * 不是先退旧批次 LOT-01105」）：退回供应商的就是这张单收进来的那批货，按 FEFO 会先扣到别的
 * 采购单收进来的老批次，老批次被凭空扣掉、这张单的批次反倒留着退不掉的余量。
 */
export async function consumeLotsPreferring(
  client: LotClient, productId: string, qty: number, preferLotIds: string[],
): Promise<LotMovement[]> {
  if (!(qty > 0)) return []
  let remaining = qty
  const consumed: LotMovement[] = []
  const ids = [...new Set(preferLotIds)]
  if (ids.length > 0) {
    const rows = await client.lot.findMany({
      where: { id: { in: ids }, productId, status: 'AVAILABLE', currentQty: { gt: 0 } },
    })
    const byId = new Map(rows.map(l => [l.id, l]))
    for (const id of ids) {
      const lot = byId.get(id)
      if (!lot || remaining <= 0) continue
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
  }
  // 指定批次扣完（已被销售出库用掉一部分）才动别的批次；被扣空的指定批次已是 DEPLETED，FEFO 不会重复扣
  if (remaining > 1e-9) consumed.push(...await consumeLotsFIFO(client, productId, remaining))
  return consumed
}

/** 回补批次余量(撤回/退货)。按 consumeLotsFIFO 的消耗顺序反着回补——保质期最晚的批次最可能是最后才被扣到的，优先还给它，不超过各批 initialQty 上限。返回实际回补的批次明细。 */
export async function restoreLotsFIFO(client: LotClient, productId: string, qty: number): Promise<LotMovement[]> {
  if (!(qty > 0)) return []
  let remaining = qty
  const restored: LotMovement[] = []
  const lots = await client.lot.findMany({
    where: { productId, status: { in: ['AVAILABLE', 'DEPLETED'] } },
    orderBy: [{ bestBefore: { sort: 'desc', nulls: 'first' } }, { arrivedAt: 'desc' }],
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
