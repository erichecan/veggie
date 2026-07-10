import { prisma } from '@/lib/db'

/**
 * 每个采购品类分组"最近一次下单"日期 —— 驱动"本周该盘货了"周期提醒（超市/日韩）
 * 和采购总览页"四个品类现状"表的"最近下单"列，两处共用同一份口径。
 * 判定：只要 PO 里有一行商品属于该分组、且 PO 未取消，就算这个分组下过单。
 */
export async function getLastPurchaseOrderDateByGroup(): Promise<Record<string, Date | null>> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const rows = (await p.$queryRawUnsafe(
    `SELECT cg.key AS group_key, MAX(po."orderDate") AS last_date
     FROM "PurchaseOrder" po
     JOIN "PurchaseOrderLine" pol ON pol."purchaseOrderId" = po.id
     JOIN "Product" pr ON pr.id = pol."productId"
     JOIN "ProductCategory" pc ON pc.id = pr."categoryId"
     JOIN "CategoryGroup" cg ON cg.id = pc."groupId"
     WHERE po.status != 'CANCELLED'
     GROUP BY cg.key`,
  )) as Array<{ group_key: string; last_date: Date }>

  const result: Record<string, Date | null> = {
    DRY_GOODS: null, JAPANESE_KOREAN: null, SUPERMARKET: null, FRESH_FROZEN: null,
  }
  for (const r of rows) result[r.group_key] = r.last_date
  return result
}
