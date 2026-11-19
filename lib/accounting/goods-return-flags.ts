import { prisma } from '@/lib/db'

export type GoodsReturnStage = 'warehouse_pending' | 'sales_pending' | 'approved' | 'rejected' | 'settled'

export interface GoodsReturnFlag {
  stage: GoodsReturnStage
  productName: string
  quantity: number
}

/** Canonical returns include driver and warehouse reports. Unresolved stages take priority
 * over newer terminal records so receipt reconciliation does not hide a blocked invoice.
 * Old JSON-only records can only fall back to the order's historical terminal badge.
 */

export async function getGoodsReturnFlags(orderIds: string[]): Promise<Map<string, GoodsReturnFlag>> {
  const flags = new Map<string, GoodsReturnFlag>()
  if (orderIds.length === 0) return flags

  const orderReturns = await prisma.orderReturn.findMany({
    where: { orderId: { in: orderIds } },
    select: { orderId: true, status: true, productName: true, quantity: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
  })
  // Prioritize unresolved entries; a newer rejection must not hide another pending return.
  const priority: Record<string, number> = { WAREHOUSE_PENDING: 0, PENDING_REVIEW: 1, APPROVED: 2, REJECTED: 3, SETTLED: 4 }
  orderReturns.sort((a, b) => priority[a.status] - priority[b.status])
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
