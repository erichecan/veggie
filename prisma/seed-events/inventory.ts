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

/**
 * 期初库存补足：确保任何商品净库存不为负。
 * 销售估算与实际有方差，少数商品会卖超采购量；此函数在所有出库流水写完后，
 * 为净库存 < target 的商品补一条 IN 调整流水（回填到 backdate，作期初库存），
 * 使最终 qtyOnHand 落在 [target, ...]。不挂 Lot（OUT 本就不逐 Lot 消耗），
 * 不触动订单/发票/凭证，守恒与批次不变量均不受影响。
 * 返回补足的商品数。
 */
export async function ensureNonNegativeStock(
  prisma: PrismaClient,
  backdate: Date,
  target = 24,
): Promise<number> {
  const rows = await prisma.$queryRawUnsafe<Array<{ productId: string; name: string; total: number }>>(
    `SELECT s."productId", p.name, s.total::float8 AS total
     FROM (SELECT "productId", SUM(qty)::numeric AS total FROM "StockMove" GROUP BY "productId") s
     JOIN "Product" p ON p.id = s."productId"
     WHERE s.total < ${target}`,
  )
  if (rows.length === 0) return 0
  await prisma.stockMove.createMany({
    data: rows.map((r) => ({
      productId: r.productId,
      productName: r.name,
      type: 'IN' as const,
      qty: Math.ceil(target - r.total),
      note: '期初库存补足（避免负库存）',
      sourceType: 'ADJUSTMENT',
      sourceRef: 'OPENING-ADJ',
      movedAt: backdate,
    })),
  })
  return rows.length
}
