/**
 * 打印单据「可售单位换算说明」的查询部分（server-only）
 * ============================================================================
 * 跟同文件旁边的 `loadPackSpecMap`（`trip-loader.ts`）走同一套既有模式：
 * **live 查询，不落库快照**——这类"包装规格"信息本来就是现有 `packSpec`
 * （拆箱用）的取法，是打印时现查 ProductSaleUom/Uom，不是订单行的金额字段，
 * 改了商品配置只影响"这行的说明文字长什么样"，不影响历史单据的金额/数量，
 * 复用这套已验证过的取舍，不需要给 OrderLine 新增快照字段。
 *
 * 与 `loadPackSpecMap` 的区别：那个只取"factor 最大的那个大单位"（给拆箱用），
 * 这个按 `productId::uomId` 精确取"这一行实际选的是哪个单位"，取不到（该行选的
 * 就是基准单位，或商品没配这个可售单位了）时不返回换算说明。
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
  const productIds = [...new Set(pairs.filter(p => p.uomId).map(p => p.productId))]
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
  return map
}
