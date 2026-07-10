import { prisma } from '@/lib/db'

export interface GroupReceiptEvent {
  id: string
  poName: string
  arrivedAt: Date
  lineCount: number
  totalQty: number
}

/**
 * 某采购品类分组近 N 个月的实际到货记录（GoodsReceipt），按到货日期升序。
 * 用于年度计划页的"到货时间轴"——只展示真实发生过的收货，不臆造季度节点。
 */
export async function getRecentGoodsReceiptsForGroup(groupKey: string, months = 12): Promise<GroupReceiptEvent[]> {
  const since = new Date()
  since.setMonth(since.getMonth() - months)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const rows = (await p.$queryRawUnsafe(
    `SELECT DISTINCT gr.id, gr."arrivedAt", po.name AS po_name, gr.lines
     FROM "GoodsReceipt" gr
     JOIN "PurchaseOrder" po ON po.id = gr."purchaseOrderId"
     JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po.id
     JOIN "Product" pr ON pr.id = pol."productId"
     JOIN "ProductCategory" pc ON pc.id = pr."categoryId"
     JOIN "CategoryGroup" cg ON cg.id = pc."groupId"
     WHERE cg.key = $1 AND gr."arrivedAt" >= $2
     ORDER BY gr."arrivedAt" ASC`,
    groupKey, since,
  )) as Array<{ id: string; arrivedAt: Date; po_name: string; lines: Array<{ qty: number }> }>

  return rows.map(r => ({
    id: r.id,
    poName: r.po_name,
    arrivedAt: r.arrivedAt,
    lineCount: Array.isArray(r.lines) ? r.lines.length : 0,
    totalQty: Array.isArray(r.lines) ? r.lines.reduce((s, l) => s + Number(l.qty ?? 0), 0) : 0,
  }))
}
