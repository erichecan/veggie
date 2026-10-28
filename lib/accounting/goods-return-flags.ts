import { prisma } from '@/lib/db'

export type GoodsReturnStage = 'warehouse_pending' | 'sales_pending' | 'approved' | 'rejected' | 'settled'

export interface GoodsReturnFlag {
  stage: GoodsReturnStage
  productName: string
  quantity: number
}

/**
 * 核销清单的退换货异常徽章（20261028 M6）。
 * OrderReturn（手工登记路径）按 orderId 精确查，覆盖包括 WAREHOUSE_PENDING/PENDING_REVIEW
 * 的全部状态；Trip 路径（司机报备）的退换货活在 Trip.restaurants[].returns[] JSON 里没有
 * orderId 索引，只能退回到 Order.goodsReturnStatus/goodsReturnedAt 这两个"终态角标"字段兜底。
 * 已知局限：Trip 路径的退换货如果还停在待核实/待审核，这里看不到——不做全表扫 Trip 的复杂方案。
 */
export async function getGoodsReturnFlags(orderIds: string[]): Promise<Map<string, GoodsReturnFlag>> {
  const flags = new Map<string, GoodsReturnFlag>()
  if (orderIds.length === 0) return flags

  const orderReturns = await prisma.orderReturn.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, status: true, productName: true, quantity: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  const covered = new Set<string>()
  for (const r of orderReturns) {
    if (covered.has(r.orderId)) continue // 同订单多条记录取最新一条（createdAt desc 已排好序）
    covered.add(r.orderId)
    const stage: GoodsReturnStage =
      r.status === 'WAREHOUSE_PENDING' ? 'warehouse_pending'
      : r.status === 'PENDING_REVIEW' ? 'sales_pending'
      : r.status === 'APPROVED' ? 'approved'
      : r.status === 'REJECTED' ? 'rejected'
      : 'settled'
    flags.set(r.orderId, { stage, productName: r.productName, quantity: Number(r.quantity) })
  }

  const remainingIds = orderIds.filter(id => !covered.has(id))
  if (remainingIds.length > 0) {
    const orders = await prisma.order.findMany({
      where: { id: { in: remainingIds }, goodsReturnStatus: { in: ['APPROVED', 'REJECTED'] } },
      select: { id: true, goodsReturnStatus: true },
    })
    for (const o of orders) {
      flags.set(o.id, {
        stage: o.goodsReturnStatus === 'APPROVED' ? 'approved' : 'rejected',
        productName: '',
        quantity: 0,
      })
    }
  }
  return flags
}
