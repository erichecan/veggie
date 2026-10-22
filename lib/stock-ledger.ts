/**
 * 库存总账：唯一的入账函数 —— 20261014（复式改造 L3，docs/20261014-double-entry-ledger-plan.md）
 * ============================================================================
 * 以前 11 个文件各自「改 qtyOnHand + 扣/补批次 + 写一笔单边 StockMove」，三件事谁漏了谁不报错。
 * 现在任何库存变化都只调 postStockMove：同一事务里写流水、改 Product.qtyOnHand、按批次扣/补
 * Lot.currentQty，并在流水上记下**从哪个库位到哪个库位**（复式）：
 *
 *   收货         Vendors   → WH/Stock      客户退货     Customers → WH/Stock
 *   销售出库     WH/Stock  → Customers     报废         WH/Stock  → Scrap
 *   退供应商     WH/Stock  → Vendors       盘点/调整    Inventory ⇄ WH/Stock
 *   期初         Opening   → WH/Stock
 *
 * 约定（与改造前的读方完全兼容）：
 *   - StockMove.qty 仍是**带符号**的「对 WH/Stock（= Product.qtyOnHand）的净影响」：进仓为正、出仓为负。
 *     分析报表、库存趋势、批次追溯都按这个口径加总，所以不改它；数量的方向由 from/to 表达。
 *   - 所有库位的余额相加恒为 0（每笔流水一进一出），ledger-check 会验。
 *   - 每笔流水带单位成本 unitCost（批次成本优先，其次商品平均成本），供存货估值凭证（L5）用。
 *
 * ⛔ 别处不要直接写 qtyOnHand / Lot.currentQty、也不要直接 stockMove.create，
 *    tests/ledger-balance-writers.test.ts 会扫描代码，漏网直接测试失败。
 */
import { consumeLotsFIFO, consumeLotsPreferring, restoreLotsFIFO, type LotMovement } from '@/lib/inventory'
import { postStockValuation } from '@/lib/stock-valuation'
import { INTERNAL_LOCATIONS } from '@/lib/stock-locations'

export { LOC, INTERNAL_LOCATIONS, type LocationId } from '@/lib/stock-locations'

export type StockMoveKind = 'IN' | 'OUT' | 'ADJUSTMENT' | 'RETURN' | 'SCRAP'

export type LotMode =
  /** 出库按 FEFO 扣批次；入库（退回/撤销）按 FEFO 反序回补。
   *  preferLotIds（只对出库生效）：先扣这些批次，不够再 FEFO——采购退货先退这张单自己收进来的批次 */
  | { mode: 'fefo'; preferLotIds?: string[] }
  /** 指定批次：adjustLot=true 时按方向增减该批次余量（报废指定批次、手工调整）；false 只记 lotId（新建批次时余量已在建批次时设好） */
  | { mode: 'lot'; lotId: string; adjustLot: boolean }
  /** 不涉及批次 */
  | { mode: 'none' }

export interface StockPosting {
  productId: string
  productName?: string
  /** 正数，库存记账单位（基础单位） */
  qty: number
  from: string
  to: string
  type: StockMoveKind
  sourceType?: string | null
  sourceId?: string | null
  sourceRef?: string | null
  note?: string | null
  movedAt?: Date
  lot?: LotMode
  orderLineId?: string | null
  purchaseOrderLineId?: string | null
  /** 业务单位下的原始数量（如 2 箱），只做展示 */
  uomQty?: number | null
  uomId?: string | null
  /** 指定单位成本（收货按采购价）；不传则取批次成本 → 商品平均成本 */
  unitCost?: number | null
  lossStage?: string | null
  lossReason?: string | null
  partnerId?: string | null
  createdBy?: string | null
  /** 存货估值凭证（L5）的操作人；不传记为 system */
  userId?: string | null
}

export interface PostedMove {
  id: string
  qty: number
  lotId: string | null
  unitCost: number | null
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Tx = any

const n = (v: unknown) => (v == null ? 0 : Number(v))
const r3 = (v: number) => Math.round(v * 1000) / 1000

export function isInternal(locationId: string): boolean {
  return INTERNAL_LOCATIONS.has(locationId)
}

/** 对 WH/Stock 的方向：+1 进仓，−1 出仓。两端都在仓内或都在仓外的流水目前不允许 */
export function directionOf(from: string, to: string): 1 | -1 {
  const fi = isInternal(from), ti = isInternal(to)
  if (fi === ti) throw new Error(`库存流水必须一端在仓内、一端在仓外（from=${from}, to=${to}）`)
  return ti ? 1 : -1
}

/**
 * 入账。必须在调用方的事务里调用。非实物商品（服务/耗材）直接返回空数组——不记库存。
 * 返回实际写入的流水（按批次拆分后可能多笔）。
 */
export async function postStockMove(tx: Tx, p: StockPosting): Promise<PostedMove[]> {
  const qty = r3(p.qty)
  if (!(qty > 0)) return []
  const sign = directionOf(p.from, p.to)

  const product = await tx.product.findUnique({
    where: { id: p.productId },
    select: { id: true, name: true, type: true, standardPrice: true },
  })
  if (!product) throw Object.assign(new Error(`商品不存在：${p.productId}`), { status: 404 })
  if (product.type !== 'PRODUCT') return []

  // ── 批次 ──
  let segments: Array<{ lotId: string | null; qty: number; lotCost: number | null }> = []
  const lot = p.lot ?? { mode: 'none' as const }
  if (lot.mode === 'fefo') {
    const moved: LotMovement[] = sign < 0
      ? (lot.preferLotIds?.length
          ? await consumeLotsPreferring(tx, p.productId, qty, lot.preferLotIds)
          : await consumeLotsFIFO(tx, p.productId, qty))
      : await restoreLotsFIFO(tx, p.productId, qty)
    const costs = moved.length
      ? new Map<string, number | null>((await tx.lot.findMany({
          where: { id: { in: moved.map(m => m.lotId) } }, select: { id: true, unitCost: true },
        })).map((l: { id: string; unitCost: unknown }) => [l.id, l.unitCost == null ? null : n(l.unitCost)]))
      : new Map<string, number | null>()
    segments = moved.map(m => ({ lotId: m.lotId, qty: r3(m.qty), lotCost: costs.get(m.lotId) ?? null }))
    const rest = r3(qty - segments.reduce((s, x) => s + x.qty, 0))
    // 超卖/超退：没有批次可扣/可补的部分仍要一笔不带批次的流水，保证 qtyOnHand 有完整明细
    if (rest > 0) segments.push({ lotId: null, qty: rest, lotCost: null })
  } else if (lot.mode === 'lot') {
    const l = await tx.lot.findUnique({ where: { id: lot.lotId }, select: { id: true, productId: true, currentQty: true, unitCost: true } })
    if (!l || l.productId !== p.productId) throw Object.assign(new Error('批次不存在或不属于该商品'), { status: 400 })
    if (lot.adjustLot) {
      const after = n(l.currentQty) + sign * qty
      await tx.lot.update({
        where: { id: l.id },
        data: { currentQty: { increment: sign * qty }, status: after <= 0 ? 'DEPLETED' : 'AVAILABLE' },
      })
    }
    segments = [{ lotId: l.id, qty, lotCost: l.unitCost == null ? null : n(l.unitCost) }]
  } else {
    segments = [{ lotId: null, qty, lotCost: null }]
  }

  await tx.product.update({ where: { id: p.productId }, data: { qtyOnHand: { increment: sign * qty } } })

  const fallbackCost = product.standardPrice == null ? null : n(product.standardPrice)
  const out: PostedMove[] = []
  for (const seg of segments) {
    const unitCost = p.unitCost ?? seg.lotCost ?? fallbackCost
    const created = await tx.stockMove.create({
      data: {
        productId: p.productId,
        productName: p.productName ?? product.name ?? '',
        type: p.type,
        qty: sign * seg.qty,
        fromLocationId: p.from,
        toLocationId: p.to,
        lotId: seg.lotId,
        note: p.note ?? null,
        sourceType: p.sourceType ?? null,
        sourceId: p.sourceId ?? null,
        sourceRef: p.sourceRef ?? null,
        movedAt: p.movedAt ?? new Date(),
        orderLineId: p.orderLineId ?? null,
        purchaseOrderLineId: p.purchaseOrderLineId ?? null,
        // 按批次拆成多笔时，业务单位数量按比例分摊（各笔加总仍等于原数量，采购行已收量据此核对）
        uomQty: p.uomQty == null ? null : segments.length === 1 ? p.uomQty : r3((p.uomQty * seg.qty) / qty),
        uomId: p.uomId ?? null,
        unitCost,
        value: unitCost == null ? null : Math.round(seg.qty * unitCost * 100) / 100,
        lossStage: p.lossStage ?? null,
        lossReason: p.lossReason ?? null,
        partnerId: p.partnerId ?? null,
        createdBy: p.createdBy ?? null,
      },
      select: { id: true },
    })
    out.push({ id: created.id, qty: sign * seg.qty, lotId: seg.lotId, unitCost })
  }
  await postStockValuation(tx, {
    moves: out, from: p.from, to: p.to, type: p.type,
    productName: p.productName ?? product.name ?? '', reference: p.sourceRef ?? null,
    partnerId: p.partnerId ?? null, movedAt: p.movedAt ?? new Date(),
  }, p.userId ?? 'system')
  return out
}

/**
 * 某张单据（sourceType + sourceId）在某商品上已经从仓里拿走的净数量（正数 = 拿走了）。
 * 订单的库存联动全部按「目标 − 已拿」对账（syncOrderStock），而不是按 orderedQty 盲目加减——
 * 这样从没扣过库存的单（历史导入、绕过确认路径直接建成 CONFIRMED 的单）取消/减量时
 * 不会凭空「释放」出库存。
 */
export async function takenBySource(tx: Tx, sourceTypes: string[], sourceId: string): Promise<Map<string, number>> {
  const rows = await tx.stockMove.groupBy({
    by: ['productId'],
    where: { sourceType: { in: sourceTypes }, sourceId },
    _sum: { qty: true },
  })
  return new Map(rows.map((r: { productId: string; _sum: { qty: unknown } }) => [r.productId, r3(-n(r._sum.qty))]))
}
