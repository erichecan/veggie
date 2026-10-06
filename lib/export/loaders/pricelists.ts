import { prisma } from '@/lib/db'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { PricelistExportRow } from '../columns/pricelists'
import type { PricelistItemInput } from '@/lib/pricelist-item'

export async function loadPricelistsForExport(ctx: ExportLoadContext): Promise<ExportLoadResult<PricelistExportRow>> {
  const [total, pricelists] = await Promise.all([
    prisma.odooPricelist.count({}),
    prisma.odooPricelist.findMany({ orderBy: { sequence: 'asc' }, take: ctx.limit }),
  ])

  // 规则里引用的商品/分类/单位/嵌套价格表 id —— 只查实际出现过的那些，不要把全库商品都捞出来
  const productIds = new Set<string>()
  const categoryIds = new Set<string>()
  const uomIds = new Set<string>()
  const pricelistIds = new Set<string>()
  for (const pl of pricelists) {
    const items = (pl.items as unknown as PricelistItemInput[]) ?? []
    for (const it of items) {
      if (it.productTemplateId) productIds.add(it.productTemplateId)
      if (it.productVariantId) productIds.add(it.productVariantId)
      if (it.categoryId) categoryIds.add(it.categoryId)
      if (it.uomId) uomIds.add(it.uomId)
      if (it.basedOnPricelistId) pricelistIds.add(it.basedOnPricelistId)
    }
  }

  const [products, categories, uoms, basedOnLists] = await Promise.all([
    productIds.size ? prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, name: true } }) : [],
    categoryIds.size ? prisma.productCategory.findMany({ where: { id: { in: [...categoryIds] } }, select: { id: true, name: true } }) : [],
    uomIds.size ? prisma.uom.findMany({ where: { id: { in: [...uomIds] } }, select: { id: true, name: true } }) : [],
    pricelistIds.size ? prisma.odooPricelist.findMany({ where: { id: { in: [...pricelistIds] } }, select: { id: true, name: true } }) : [],
  ])
  const productName = new Map(products.map(p => [p.id, p.name]))
  const categoryName = new Map(categories.map(c => [c.id, c.name]))
  const uomName = new Map(uoms.map(u => [u.id, u.name]))
  const pricelistName = new Map(basedOnLists.map(p => [p.id, p.name]))

  const rows: PricelistExportRow[] = []
  for (const pl of pricelists) {
    const items = (pl.items as unknown as PricelistItemInput[]) ?? []
    const base: Omit<PricelistExportRow, keyof ReturnType<typeof itemFields>> = {
      externalId: pl.externalId,
      pricelistName: pl.name,
      currency: pl.currency,
      active: pl.active,
      selectable: pl.selectable,
      pricelistSequence: pl.sequence,
    }
    if (items.length === 0) {
      rows.push({ ...base, ...itemFields(null) })
      continue
    }
    for (const it of items) {
      rows.push({
        ...base,
        ...itemFields(it, { productName, categoryName, uomName, pricelistName }),
      })
    }
  }

  return { rows, total }

  function itemFields(
    it: PricelistItemInput | null,
    maps?: { productName: Map<string, string>; categoryName: Map<string, string>; uomName: Map<string, string>; pricelistName: Map<string, string> },
  ) {
    if (!it || !maps) {
      return {
        itemId: null, applyOn: null, categoryName: null, productName: null, minQty: null,
        dateStart: null, dateEnd: null, computeType: null, fixedPrice: null, percentDiscount: null,
        formulaBase: null, basedOnPricelistName: null, priceDiscount: null, priceSurcharge: null,
        priceMinMargin: null, priceMaxMargin: null, roundingMethod: null, itemSequence: null,
        uomName: null, badgeLabel: null,
      }
    }
    const productId = it.productTemplateId ?? it.productVariantId
    return {
      itemId: it.id ?? null,
      applyOn: it.applyOn,
      categoryName: it.categoryId ? (maps.categoryName.get(it.categoryId) ?? it.categoryId) : null,
      productName: productId ? (maps.productName.get(productId) ?? productId) : null,
      minQty: it.minQty ?? 0,
      dateStart: it.dateStart ?? null,
      dateEnd: it.dateEnd ?? null,
      computeType: it.computeType,
      fixedPrice: it.fixedPrice ?? null,
      percentDiscount: it.percentDiscount ?? null,
      formulaBase: it.formulaBase ?? null,
      basedOnPricelistName: it.basedOnPricelistId ? (maps.pricelistName.get(it.basedOnPricelistId) ?? it.basedOnPricelistId) : null,
      priceDiscount: it.priceDiscount ?? null,
      priceSurcharge: it.priceSurcharge ?? null,
      priceMinMargin: it.priceMinMargin ?? null,
      priceMaxMargin: it.priceMaxMargin ?? null,
      roundingMethod: it.roundingMethod ?? null,
      itemSequence: it.sequence ?? null,
      uomName: it.uomId ? (maps.uomName.get(it.uomId) ?? it.uomId) : null,
      badgeLabel: it.badgeLabel ?? null,
    }
  }
}
