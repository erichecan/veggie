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

// 多单位销售(ProductSaleUom, 20260714)换算用的最小 client 形状
type StockQtyClient = {
  product: { findUnique: (args: unknown) => Promise<{ templateId: string } | null> }
  productTemplate: { findUnique: (args: unknown) => Promise<{ uomId: string | null } | null> }
  uom: { findUnique: (args: unknown) => Promise<{ factor: unknown } | null> }
}

/**
 * 多单位销售换算：把订单行选用单位的数量换算成"库存记账单位"(= 该商品 ProductTemplate.uomId
 * 当前设置的那个单位)的数量。qtyOnHand/Lot 从上线起就隐式按"商品当前销售单位"计数——只有当
 * 商品配置了 ProductSaleUom(多个可售单位)、且这一行选的不是那个默认(锚点)单位时才需要换算，
 * 换算公式 = qty × (行选单位.factor / 锚点单位.factor)。
 * 其余情况(绝大多数商品从未配置多单位、或这行本来就用默认单位)原样返回 qty，
 * 与"多单位"功能上线前的行为完全一致，不影响任何存量数据。
 */
export async function toStockQty(
  client: StockQtyClient,
  productId: string,
  qty: number,
  lineUomId: string | null | undefined,
): Promise<number> {
  if (!lineUomId || qty === 0) return qty
  const product = await client.product.findUnique({ where: { id: productId }, select: { templateId: true } })
  if (!product) return qty
  const template = await client.productTemplate.findUnique({ where: { id: product.templateId }, select: { uomId: true } })
  const anchorUomId = template?.uomId
  if (!anchorUomId || anchorUomId === lineUomId) return qty
  const [lineUom, anchorUom] = await Promise.all([
    client.uom.findUnique({ where: { id: lineUomId }, select: { factor: true } }),
    client.uom.findUnique({ where: { id: anchorUomId }, select: { factor: true } }),
  ])
  const lineFactor = n(lineUom?.factor)
  const anchorFactor = n(anchorUom?.factor)
  if (!lineFactor || !anchorFactor) return qty
  return qty * (lineFactor / anchorFactor)
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
