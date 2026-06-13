/**
 * 库存重算：从 StockMove 汇总回写 qtyOnHand（一条 SQL，天然守恒）
 * 事件期间只写流水、不增量改 qtyOnHand，跑完用此函数一次性对齐。
 */
import type { PrismaClient } from '../../lib/generated/prisma/client'

export async function recomputeOnHand(prisma: PrismaClient): Promise<void> {
  await prisma.$executeRawUnsafe(`UPDATE "Product" SET "qtyOnHand" = 0`)
  await prisma.$executeRawUnsafe(`
    UPDATE "Product" p
    SET "qtyOnHand" = s.total
    FROM (SELECT "productId", SUM(qty)::numeric AS total FROM "StockMove" GROUP BY "productId") s
    WHERE p.id = s."productId"`)
}
