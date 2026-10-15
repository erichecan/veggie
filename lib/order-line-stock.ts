/**
 * 订单行改量时的库存联动（台账 D6）
 * ============================================================================
 * 确认订单时已按下单量扣过库存，之后**任何**改量都必须把差额补回/补扣，并且
 * **同时写一笔 StockMove** —— 头号不变量是 `qtyOnHand == Σ StockMove`，
 * 只动 qtyOnHand 不记流水，这个商品从此就不守恒了（E5 周期已在收货损坏品那条
 * 路径上踩过同一个坑：两条路径对同一件事的记账方式不一致，谁都不报错）。
 *
 * ⚠️ 这正是缺货处理路径此前的缺陷：`PUT /api/orders/[id]`（订单详情整单保存）
 * 一直是「改 qtyOnHand + 写 StockMove + 按单位换算」三件事齐全的，而
 * `PATCH /api/orders/[id]/lines/[lineId]`（缺货 tab 改量走的就是它）
 * 只做了第一件 —— 既不记流水，也不做大小单位换算（按箱下的单，减 5 箱只补回 5 件）。
 *
 * 这里把这段逻辑收成一处，供缺货相关的写入路径共用。
 * （`PUT /api/orders/[id]` 的多行/换单位场景与这里语义相同但纠缠在整单 diff 里，
 * 暂未改写，见该文件 P0-1 段落 —— 两边的记账约定必须保持一致。）
 */
import { syncOrderStock } from '@/lib/order-stock'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type TxClient = any

export interface LineStockChange {
  productId: string
  productName: string
  /** 该行原数量（按行自己的单位） */
  oldQty: number
  /** 该行新数量（按行自己的单位）；整行删除传 0 */
  newQty: number
  /** 行单位；为空表示就是库存记账单位 */
  uomId: string | null | undefined
  /** 流水备注里的来源说明，如「缺货减量」 */
  reasonLabel: string
  orderId: string
  orderCode: string
  movedAt?: Date
}

/**
 * 行改量后的库存联动：调用方**先把行写进库**，再调这里。
 * 20261014（复式改造 L3）起不再按 old/new 差额自己加减，而是委托 syncOrderStock 按
 * 「订单应占用 − 流水里已拿」对账：报价单（PENDING）改量不再动库存，从没扣过库存的单减量
 * 也不会凭空补回。返回该商品实际变动的库存数量（正 = 补回仓库，负 = 多扣）。
 */
export async function applyLineStockDelta(tx: TxClient, c: LineStockChange): Promise<number> {
  const r = await syncOrderStock(tx, c.orderId, {
    reason: `${c.reasonLabel} ${c.oldQty}→${c.newQty}`,
    movedAt: c.movedAt,
    // 缺货/差异处理发生在送货当天，单子可能已是 COMPLETED；只对有过流水的单生效（见 syncOrderStock）
    allowCompleted: true,
  })
  const hit = r.changed.find(x => x.productId === c.productId)
  return hit ? -hit.delta : 0
}
