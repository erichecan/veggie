import { Prisma } from './generated/prisma/client'
import { prisma } from './db'
import {
  validateSaleUomItems, normalizeFactor, normalizeUomSequence, normalizeGrossWeight,
  type SaleUomItemInput,
} from './sale-uom'

/**
 * 商品可售单位(ProductSaleUom)整份替换的落库逻辑 —— 从
 * PUT /api/products/[id]/sale-uoms 抽出(20260930)，供该路由与商品批量导入共用，
 * 避免两处各写一份、行为逐渐漂移。
 *
 * 逐字保留原路由的两条核心规则：
 * 1. 「基准单位单一入口」：商品已设置 uomId 时，isDefault 完全由 uomId===product.uomId
 *    派生，忽略调用方提交的每行 isDefault；命中的那行 factor 强制归一为 1；提交列表里
 *    没有一行命中基准单位时，自动补一行(factor=1, priceOverride=null, active=true)一起存。
 *    商品尚未设置过销售单位(product.uomId 为空)时，维持旧行为：按提交的 isDefault 原样使用，
 *    并顺带把提交的默认单位回写进 product.uomId(仅当前商品还没设过才补一次)。
 * 2. deleteMany 清掉不在本次提交列表里的行，再按 uomId 逐个 upsert。
 */

/** 事务内可用的最小客户端接口，顶层 prisma 或 $transaction 的 tx 都满足 */
type DbClient = Prisma.TransactionClient | typeof prisma

export interface NormalizeSaleUomResult {
  /** 归一化后的行；调用方拿它继续走 upsertProductSaleUomRows() */
  items: SaleUomItemInput[]
  /** 校验错误；非 null 时不应再落库 */
  error: string | null
}

/**
 * 基准单位单一入口的归一化 + 校验(纯函数，不碰数据库)。
 * `baseUomId` 传 `product.uomId`(可能为 null，表示该商品还没设置过销售单位)。
 */
export function normalizeAndValidateSaleUomItems(
  items: SaleUomItemInput[],
  baseUomId: string | null | undefined,
): NormalizeSaleUomResult {
  let normalized: SaleUomItemInput[] = items
  if (baseUomId) {
    normalized = items.map(it => {
      const isDefault = String(it.uomId ?? '') === baseUomId
      // 换基准单位后，新变成基础的那一行系数可能还留着换基准单位前的旧值 ——
      // 基础单位的换算只能是 1，这里直接归一。
      return { ...it, isDefault, factor: isDefault ? 1 : it.factor }
    })
    if (!normalized.some(it => it.isDefault)) {
      normalized = [
        ...normalized,
        { uomId: baseUomId, isDefault: true, factor: 1, priceOverride: null, active: true },
      ]
    }
  }
  const error = validateSaleUomItems(normalized)
  return { items: normalized, error }
}

/**
 * deleteMany + 按 uomId 逐个 upsert。调用方须先用 normalizeAndValidateSaleUomItems()
 * 校验通过(error === null)再调这个函数；这个函数本身不再校验。
 *
 * `baseUomId` 为 null 时(商品历史上从未设置过销售单位)，顺带把提交的默认单位回写进
 * product.uomId —— 与旧逻辑"仅当前商品还没设过才补一次"一致。
 */
export async function upsertProductSaleUomRows(
  tx: DbClient,
  productId: string,
  baseUomId: string | null | undefined,
  items: SaleUomItemInput[],
  updatedBy: string,
): Promise<void> {
  const uomIds = items.map(it => String(it.uomId ?? ''))

  await tx.productSaleUom.deleteMany({
    where: { productId, uomId: { notIn: uomIds } },
  })

  if (!baseUomId) {
    const baseItem = items.find(it => it.isDefault)
    if (baseItem?.uomId) {
      await tx.product.update({
        where: { id: productId },
        data: { uomId: String(baseItem.uomId) },
      })
    }
  }

  for (const it of items) {
    const priceMode = it.priceMode === 'FIXED' || it.priceMode === 'FORMULA' ? it.priceMode : 'AUTO'
    const priceDiscountPct = it.priceDiscountPct != null && it.priceDiscountPct !== '' ? Number(it.priceDiscountPct) : 0
    const priceSurcharge = it.priceSurcharge != null && it.priceSurcharge !== '' ? Number(it.priceSurcharge) : 0
    const commissionPriceMode = it.commissionPriceMode === 'FIXED' || it.commissionPriceMode === 'FORMULA' ? it.commissionPriceMode : 'AUTO'
    const commissionDiscountPct = it.commissionDiscountPct != null && it.commissionDiscountPct !== '' ? Number(it.commissionDiscountPct) : 0
    const commissionSurcharge = it.commissionSurcharge != null && it.commissionSurcharge !== '' ? Number(it.commissionSurcharge) : 0
    const spec = typeof it.spec === 'string' && it.spec.trim() ? it.spec.trim() : null
    const sequence = normalizeUomSequence(it.sequence)
    const grossWeight = normalizeGrossWeight(it.grossWeight)
    const factor = it.isDefault ? 1 : normalizeFactor(it.factor)
    const uomId = String(it.uomId)

    await tx.productSaleUom.upsert({
      where: { productId_uomId: { productId, uomId } },
      create: {
        productId,
        uomId,
        isDefault: !!it.isDefault,
        factor,
        priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
        priceMode, priceDiscountPct, priceSurcharge,
        commissionPriceOverride: it.commissionPriceOverride != null ? Number(it.commissionPriceOverride) : null,
        commissionPriceMode, commissionDiscountPct, commissionSurcharge,
        spec,
        sequence,
        grossWeight,
        updatedBy,
        active: it.active !== false,
      },
      update: {
        isDefault: !!it.isDefault,
        factor,
        priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
        priceMode, priceDiscountPct, priceSurcharge,
        commissionPriceOverride: it.commissionPriceOverride != null ? Number(it.commissionPriceOverride) : null,
        commissionPriceMode, commissionDiscountPct, commissionSurcharge,
        spec,
        sequence,
        grossWeight,
        updatedBy,
        active: it.active !== false,
      },
    })
  }
}
