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
/**
 * 期初余额：把商品库存补到 target，用一笔标记为期初的 ADJUSTMENT 流水实现。
 *
 * 这是 20260811 拍板的口径落地（台账待决策 9）：**不追溯补历史出入库流水**，
 * 起算日之前的存量一律作期初余额，起算日之后严格走流水。原因是生产库有 133 万
 * 订单行、604 条出库流水，补历史等于凭空造 133 万条无据可依的记录。
 *
 * 与 `ensureNonNegativeStock` 的区别（两者都要留着，用途不同）：
 *   ensureNonNegativeStock  从**流水分组表**出发 → 只能覆盖已有流水的商品，
 *                           用途是事件跑完后兜底，防止卖超成负数
 *   ensureOpeningStock      从 **Product** 出发 LEFT JOIN 流水 → 覆盖得到
 *                           「一条流水都没有」的商品，用途是给测试铺底数
 *
 * 写完流水后调 recomputeOnHand，qtyOnHand 由流水汇总而来，守恒天然成立。
 */
export async function ensureOpeningStock(
  prisma: PrismaClient,
  opts: { target: number; backdate: Date; productIds?: readonly string[] },
): Promise<number> {
  const { target, backdate, productIds } = opts
  const filter = productIds && productIds.length > 0
    ? `AND p.id = ANY($1::text[])`
    : `AND p.active = true`
  const params = productIds && productIds.length > 0 ? [productIds] : []

  // 从 Product 出发 LEFT JOIN 流水 —— 这是与 ensureNonNegativeStock 的关键差别：
  // 那个函数从流水分组表出发，天然看不见「一条流水都没有」的商品。
  const rows = await prisma.$queryRawUnsafe<Array<{ productId: string; name: string; total: number }>>(
    `SELECT p.id AS "productId", p.name, COALESCE(s.total, 0)::float8 AS total
     FROM "Product" p
     LEFT JOIN (SELECT "productId", SUM(qty)::numeric AS total FROM "StockMove" GROUP BY "productId") s
       ON s."productId" = p.id
     WHERE COALESCE(s.total, 0) < ${target} ${filter}`,
    ...params,
  )
  if (rows.length === 0) return 0

  await prisma.stockMove.createMany({
    data: rows.map((r) => ({
      productId: r.productId,
      productName: r.name,
      type: 'ADJUSTMENT' as const,
      qty: Math.ceil(target - r.total),
      note: OPENING_NOTE,
      sourceType: 'ADJUSTMENT',
      sourceRef: OPENING_REF,
      movedAt: backdate,
    })),
  })
  await recomputeOnHand(prisma)
  return rows.length
}

/** 期初流水的固定标记，便于识别与回滚 */
export const OPENING_NOTE = '期初余额（起算日之前的存量，不追溯历史流水）'
export const OPENING_REF = 'OPENING-BALANCE'

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
