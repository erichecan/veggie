import { prisma } from '@/lib/db'
import type { ExportLoadContext, ExportLoadResult } from '../registry'
import type { PricelistExportRow } from '../columns/pricelists'
import type { PricelistItemInput } from '@/lib/pricelist-item'
import { categoryPathMap } from '@/lib/category-path'

export async function loadPricelistsForExport(ctx: ExportLoadContext): Promise<ExportLoadResult<PricelistExportRow>> {
  // pricelistId=xxx：价格表详情页的 Action → Export 只导出这一个价格表(20261007)
  const onlyId = ctx.searchParams.get('pricelistId')
  // ids=a,b,c：列表页勾选几条 → Action → 导出所选(20261008)
  const ids = (ctx.searchParams.get('ids') ?? '').split(',').map(s => s.trim()).filter(Boolean)
  const where = onlyId ? { id: onlyId } : ids.length > 0 ? { id: { in: ids } } : {}
  const [total, pricelists] = await Promise.all([
    prisma.odooPricelist.count({ where }),
    prisma.odooPricelist.findMany({ where, orderBy: { sequence: 'asc' }, take: ctx.limit }),
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
    productIds.size ? prisma.product.findMany({ where: { id: { in: [...productIds] } }, select: { id: true, name: true, productNo: true } }) : [],
    // 分类导出完整路径(同名子分类区分得开，导入按路径对回去)——要整棵树才能拼出父级
    categoryIds.size ? prisma.productCategory.findMany({ select: { id: true, name: true, parentId: true } }) : [],
    uomIds.size ? prisma.uom.findMany({ where: { id: { in: [...uomIds] } }, select: { id: true, name: true } }) : [],
    pricelistIds.size ? prisma.odooPricelist.findMany({ where: { id: { in: [...pricelistIds] } }, select: { id: true, name: true } }) : [],
  ])
  const productName = new Map(products.map(p => [p.id, p.name]))
  const productNo = new Map(products.map(p => [p.id, p.productNo]))
  const categoryName = categoryPathMap(categories)
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
        ...itemFields(it, { productName, productNo, categoryName, uomName, pricelistName }),
      })
    }
  }

  return { rows, total }

  function itemFields(
    it: PricelistItemInput | null,
    maps?: { productName: Map<string, string>; productNo: Map<string, number>; categoryName: Map<string, string>; uomName: Map<string, string>; pricelistName: Map<string, string> },
  ) {
    if (!it || !maps) {
      return {
        itemId: null, applyOn: null, categoryName: null, productNo: null, productName: null, minQty: null,
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
      productNo: productId ? (maps.productNo.get(productId) ?? null) : null,
      // 规则指向的商品已经不在商品表里(被删掉了)：以前这里直接吐内部 id，看起来像一串乱码。
      // 现在明确标出来——这种规则不会命中任何商品，可以在价格表里删掉。
      productName: productId ? (maps.productName.get(productId) ?? `[deleted product ${productId}]`) : null,
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
