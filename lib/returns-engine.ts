import { toNum, round2 } from '@/lib/decimal-helpers'
import { toStockQty } from '@/lib/inventory'
import { postStockMove, LOC } from '@/lib/stock-ledger'
import { SCRAP_REASON_LABEL } from '@/lib/scrap-reasons'
import { recalcOrderCommission } from '@/lib/commission'

/**
 * 退货处置共用逻辑（20261027 从 app/api/trips/[id]/returns/route.ts 抽取）。
 *
 * Trip/ReturnItem（司机端上报）与 OrderReturn（日销售中心手动登记）两条入库路径
 * 共用同一套「disposition → StockMove → OrderLine 回写」规则，不允许分叉：
 *   - SELLABLE：货回可售库存，FEFO 回补批次，StockMove(RETURN, +qty)
 *   - SCRAP：StockMove(RETURN, +qty) 记客退事实 + StockMove(SCRAP, -qty) 记报废损耗，qtyOnHand 净不变
 */

export type ReturnDisposition = 'SELLABLE' | 'SCRAP'

export interface ReturnDispositionInput {
  productId: string
  productName: string
  /** 退货数量，已换算为订单行单位（非基础单位），postReturnStockMoves 内部会再换算成基础单位入账 */
  quantity: number
  disposition: ReturnDisposition
  /** disposition=SCRAP 时的报废原因 key（lib/scrap-reasons.ts），缺省 CUSTOMER_RETURN_DAMAGED */
  scrapReason?: string
  reason?: string
  /** 订单行单位，用于换算成基础单位入账 */
  uomId: string | null
  partnerId: string | null
  partnerName: string
  /** StockMove.sourceType 基础前缀，报废那笔自动追加 "_SCRAP" 后缀 */
  sourceType: string
  sourceId: string
  sourceRef: string | null
}

export interface ReturnStockMovePlan {
  productId: string
  productName: string
  type: 'RETURN' | 'SCRAP'
  qty: number
  note: string
  sourceType: string
  sourceId: string
  sourceRef: string | null
  uomId: string | null
  partnerId: string | null
  /** 可再售：回补批次（FEFO）；报废：不碰批次 */
  sellable: boolean
  lossStage?: string | null
  lossReason?: string | null
}

/** 根据一条退货的处置结果，生成待入账的 StockMove 计划（不落库，纯函数）。 */
export function buildReturnStockMoves(input: ReturnDispositionInput): ReturnStockMovePlan[] {
  const moves: ReturnStockMovePlan[] = []

  // 客退入库记账：无论去向如何，先记一笔「客户 → 仓库」
  moves.push({
    uomId: input.uomId,
    partnerId: input.partnerId,
    sellable: input.disposition === 'SELLABLE',
    productId: input.productId,
    productName: input.productName,
    type: 'RETURN',
    qty: input.quantity,
    note: `退货入库(${input.disposition === 'SELLABLE' ? '可再售' : '待报废'}): ${input.partnerName} — ${input.reason ?? '无原因'}`,
    sourceType: input.sourceType,
    sourceId: input.sourceId,
    sourceRef: input.sourceRef,
  })

  if (input.disposition !== 'SELLABLE') {
    // 报废：货回来了但不能再卖，紧接着一笔「仓库 → 报废」（计入损耗仪表盘 & 退货回收率）
    const reasonKey = input.scrapReason ?? 'CUSTOMER_RETURN_DAMAGED'
    const reasonLabel = SCRAP_REASON_LABEL[reasonKey] ?? reasonKey
    moves.push({
      uomId: input.uomId,
      partnerId: input.partnerId,
      sellable: false,
      productId: input.productId,
      productName: input.productName,
      type: 'SCRAP',
      qty: -input.quantity,
      note: `客退报废(${reasonLabel}): ${input.partnerName} — ${input.reason ?? '无原因'}`,
      // 结构化归因（台账 E4）：客退报废天然属「客退」环节，不必让看板再从 note 里猜
      lossStage: 'CUSTOMER_RETURN',
      lossReason: reasonKey,
      sourceType: `${input.sourceType}_SCRAP`,
      sourceId: input.sourceId,
      sourceRef: input.sourceRef,
    })
  }

  return moves
}

/** 把一批 StockMove 计划落库（必须在事务里调用）。 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function postReturnStockMoves(
  tx: any,
  moves: ReturnStockMovePlan[],
  user: { userId: string; name?: string | null; email: string },
) {
  for (const sm of moves) {
    const stockQty = await toStockQty(tx, sm.productId, Math.abs(sm.qty), sm.uomId)
    const isScrap = sm.type === 'SCRAP'
    await postStockMove(tx, {
      productId: sm.productId,
      productName: sm.productName,
      qty: stockQty,
      from: isScrap ? LOC.STOCK : LOC.CUSTOMERS,
      to: isScrap ? LOC.SCRAP : LOC.STOCK,
      type: sm.type,
      lot: sm.sellable ? { mode: 'fefo' } : { mode: 'none' },
      note: sm.note,
      lossStage: sm.lossStage ?? null,
      lossReason: sm.lossReason ?? null,
      sourceType: sm.sourceType,
      sourceId: sm.sourceId,
      sourceRef: sm.sourceRef,
      partnerId: sm.partnerId,
      uomQty: Math.abs(sm.qty),
      uomId: sm.uomId,
      userId: user.userId,
      createdBy: user.name ?? user.email,
    })
  }
}

export interface OrderLineReduction {
  orderId: string
  productId: string
  reduceQty: number
}

/**
 * 调整 OrderLine.deliveredQty（货物已不在客户手上，不算已送达）并重算受影响订单的司机提成快照。
 * 必须在事务里调用。返回受影响的 orderId 列表，调用方可据此做进一步回写（如 Order.goodsReturnStatus）。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function applyReturnOrderLineReduction(
  tx: any,
  updates: OrderLineReduction[],
): Promise<string[]> {
  for (const upd of updates) {
    const line = await tx.orderLine.findFirst({
      where: { orderId: upd.orderId, productId: upd.productId },
      select: { id: true, deliveredQty: true },
    })
    if (line) {
      const current = toNum(line.deliveredQty)
      const newQty = round2(Math.max(0, current - upd.reduceQty))
      await tx.orderLine.update({
        where: { id: line.id },
        data: { deliveredQty: newQty },
      })
    }
  }

  const affectedOrderIds = Array.from(new Set(updates.map(u => u.orderId)))
  for (const orderId of affectedOrderIds) {
    await recalcOrderCommission(orderId, tx)
  }
  return affectedOrderIds
}

export interface GoodsReturnOrderSync {
  orderId: string
  status: 'APPROVED' | 'REJECTED'
  productName: string
  quantity: number
  disposition?: ReturnDisposition
}

/**
 * 审核/处置完成后回写 Order 的只读退货角标（20261027 M5）。
 * 故意不做跨多条退货记录的状态汇总——goodsReturnStatus 是"镶嵌角标"语义，
 * 只读展示最近一次处置结果，不是账本；同一订单极少会有第二条独立退货记录，
 * 真出现了也是后写覆盖前写，与 Order.returnStatus（核销对账）各管各的不冲突。
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function syncOrderGoodsReturnStatus(
  tx: any,
  updates: GoodsReturnOrderSync[],
  user: { userId: string },
) {
  for (const u of updates) {
    // updateMany 而非 update：Trip 路径的 orderId 来自 restaurant.orderIds 反查，
    // 跟 applyReturnOrderLineReduction 同样的不精确问题——订单可能已被删/orderId 对不上，
    // 这里要跟那边一样静默跳过而不是让整个事务 P2025 炸掉
    const { count } = await tx.order.updateMany({
      where: { id: u.orderId },
      data: {
        goodsReturnStatus: u.status,
        goodsReturnedAt: u.status === 'APPROVED' ? new Date() : null,
      },
    })
    if (count === 0) continue
    await tx.orderAuditLog.create({
      data: {
        orderId: u.orderId,
        userId: user.userId,
        action: 'goods_return_disposed',
        changedFields: {
          status: u.status,
          productName: u.productName,
          quantity: u.quantity,
          disposition: u.disposition ?? null,
        },
      },
    })
  }
}

/** 计算退款金额（精确小数）。review.refundAmount 优先，其次按百分比，否则全额。 */
export function calculateRefundAmount(
  unitPrice: number,
  quantity: number,
  review: { refundMode?: 'pct' | 'fixed'; refundPct?: number; refundAmount?: number },
): number {
  if (review.refundAmount !== undefined) return round2(review.refundAmount)
  const total = round2(unitPrice * quantity)
  if (review.refundMode === 'pct' && review.refundPct !== undefined) {
    return round2(total * review.refundPct / 100)
  }
  return total
}
