/**
 * 打印单据「可售单位换算说明」的查询部分（server-only）
 * ============================================================================
 * 跟同文件旁边的 `loadPackSpecMap`（`trip-loader.ts`）走同一套既有模式：
 * **live 查询，不落库快照**——这类"包装规格"信息本来就是现有 `packSpec`
 * （拆箱用）的取法，是打印时现查 ProductSaleUom/Uom，不是订单行的金额字段，
 * 改了商品配置只影响数量折算，不影响历史单据的金额/销售单位数量；基础单位
 * 折算会按当前商品单位配置计算。
 *
 * 与 `loadPackSpecMap` 的区别：那个只取"factor 最大的那个大单位"（给拆箱用），
 * 这个按 `productId::uomId` 精确取"这一行实际选的是哪个单位"，取不到（该行选的
 * 就是基准单位）时按 1:1 处理；被删除或无法识别的非基础单位不做猜测。
 *
 * 纯格式化部分(UomConversionInfo/uomConversionKey/formatUomConversionHint)拆在
 * `uom-conversion.ts`（无 Prisma 依赖，模板文件才能安全 import）。
 */
import 'server-only'
import { prisma } from '@/lib/db'
import { uomConversionKey, type UomConversionInfo } from './uom-conversion'

/**
 * 批量查询一组「商品 + 单位」组合的换算信息。只查真正用到的组合，不是商品全部可售单位。
 */
export async function loadUomConversionMap(
  pairs: Array<{ productId: string; uomId: string | null | undefined }>,
): Promise<Map<string, UomConversionInfo>> {
  const map = new Map<string, UomConversionInfo>()
  const productIds = [...new Set(pairs.map(p => p.productId))]
  if (productIds.length === 0) return map

  const rows = await prisma.$queryRaw<Array<{
    productId: string
    uomId: string
    uomName: string
    factor: string
    baseName: string | null
    netWeight: string | null
    grossWeight: string | null
  }>>`
    SELECT psu."productId",
           psu."uomId",
           u.name           AS "uomName",
           psu.factor::text AS factor,
           base.name        AS "baseName",
           p."netWeight"::text AS "netWeight",
           psu."grossWeight"::text AS "grossWeight"
    FROM "ProductSaleUom" psu
    JOIN "Uom" u ON u.id = psu."uomId"
    LEFT JOIN "Product" p ON p.id = psu."productId"
    LEFT JOIN "Uom" base ON base.id = p."uomId"
    WHERE psu."productId" = ANY(${productIds}) AND psu.active = true
  `

  for (const r of rows) {
    const factor = Number(r.factor)
    // 没有基准单位名可比对（join 不到）时整条都没法生成——直接跳过；
    // factor=1（就是基准单位本身）以前也跳过，但那只是「换算说明没有信息量」，
    // 毛重/净重信息量还在，20260911 起改成保留，交给 formatUomConversionHint
    // 自己判断 conversionLine 要不要显示（factor=1 时不显示换算，但重量照常算）
    if (!Number.isFinite(factor) || !r.baseName) continue
    map.set(uomConversionKey(r.productId, r.uomId), {
      factor,
      thisUomName: r.uomName,
      baseUomName: r.baseName,
      netWeight: r.netWeight != null ? Number(r.netWeight) : null,
      grossWeight: r.grossWeight != null ? Number(r.grossWeight) : null,
    })
  }

  // Some legacy products have a Product.uomId but no ProductSaleUom row yet.
  // Their selected base unit still converts 1:1 to itself, so include that
  // deterministic fallback for order quantity summaries.
  const missingBasePairs = pairs.filter(pair => {
    if (map.has(uomConversionKey(pair.productId, pair.uomId))) return false
    return true
  })
  if (missingBasePairs.length > 0) {
    const baseRows = await prisma.$queryRaw<Array<{
      productId: string
      uomId: string
      uomName: string
      baseName: string
    }>>`
      SELECT p.id AS "productId",
             base.id AS "uomId",
             base.name AS "uomName",
             base.name AS "baseName"
      FROM "Product" p
      JOIN "Uom" base ON base.id = p."uomId"
      WHERE p.id = ANY(${[...new Set(missingBasePairs.map(pair => pair.productId))]})
    `
    const baseByProduct = new Map(baseRows.map(row => [row.productId, row]))
    for (const pair of missingBasePairs) {
      const base = baseByProduct.get(pair.productId)
      // Legacy order lines without uomId predate multi-unit sales and represent the
      // product's base UOM; explicit IDs fall back only when they match that base UOM.
      if (!base || (pair.uomId != null && pair.uomId !== base.uomId)) continue
      map.set(uomConversionKey(pair.productId, pair.uomId), {
        factor: 1,
        thisUomName: base.uomName,
        baseUomName: base.baseName,
        netWeight: null,
        grossWeight: null,
      })
    }
  }
  return map
}
