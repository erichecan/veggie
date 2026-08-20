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
import { toStockQty } from '@/lib/inventory'

/** 只有实物商品(ProductTemplate.type === 'PRODUCT')才记库存；服务/耗材不动 */
const STOCKABLE_TYPE = 'PRODUCT'

// 事务句柄的最小形状（项目里多处用 prismaAny 传进来）
type TxClient = {
  product: {
    findUnique: (args: unknown) => Promise<{ templateId: string } | null>
    update: (args: unknown) => Promise<unknown>
  }
  productTemplate: { findUnique: (args: unknown) => Promise<{ uomId: string | null; type?: string } | null> }
  // 多规格换算读的是**商品级** ProductSaleUom.factor，不再是全局 Uom.factor（20260819）
  productSaleUom: {
    findMany: (args: unknown) => Promise<Array<{ uomId: string; isDefault: boolean; factor: unknown }>>
  }
  stockMove: { create: (args: unknown) => Promise<unknown> }
}

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
 * 按行数量差额调整库存并记一笔流水。返回实际变动的库存数量（正=补回，负=多扣）。
 * 非实物商品、差额为 0、或换算后差额为 0 时不做任何事并返回 0。
 */
export async function applyLineStockDelta(tx: TxClient, c: LineStockChange): Promise<number> {
  const product = await tx.product.findUnique({ where: { id: c.productId } }) as
    { templateId: string } | null
  if (!product) return 0
  const template = await tx.productTemplate.findUnique({
    where: { id: product.templateId },
    select: { type: true, uomId: true },
  }) as { type?: string } | null
  if (template?.type !== STOCKABLE_TYPE) return 0

  // 新旧数量各自换算成库存记账单位再相减 —— 直接拿 oldQty-newQty 相减在按箱下单时
  // 会少补回一个箱规倍数（I3 周期在收货侧修的是同一件事的另一半）
  const oldStockQty = await toStockQty(tx, c.productId, c.oldQty, c.uomId)
  const newStockQty = await toStockQty(tx, c.productId, c.newQty, c.uomId)
  const release = oldStockQty - newStockQty
  if (release === 0) return 0

  await tx.product.update({
    where: { id: c.productId },
    data: release > 0
      ? { qtyOnHand: { increment: release } }
      : { qtyOnHand: { decrement: Math.abs(release) } },
  })
  await tx.stockMove.create({
    data: {
      productId: c.productId,
      productName: c.productName,
      // 约定与 PUT /api/orders/[id] 一致：补回库存记 IN(正数)，多扣记 OUT(负数)，
      // 净额恒等于 qtyOnHand 的变化量
      type: release > 0 ? 'IN' : 'OUT',
      qty: release,
      movedAt: c.movedAt ?? new Date(),
      note: `订单 ${c.orderCode} ${c.reasonLabel} ${c.oldQty}→${c.newQty}`,
      sourceType: 'ORDER',
      sourceId: c.orderId,
      sourceRef: c.orderCode,
    },
  })
  return release
}
