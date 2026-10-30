import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import type { OdooPricelistItem, OdooPricelist as OdooPricelistType, Product as ProductType } from '@/lib/types'
import { computeItemPrice } from '@/lib/pricing-engine'
import { toNum, toNumOpt } from '@/lib/decimal-helpers'

/**
 * 这条规则锁定的是哪个商品——两级 applyOn 分别对应不同字段，与
 * `pricelists/[id]/page.tsx` 里同名判断逻辑保持一致（20260825 合表重构后
 * 新建/改选一律写 applyOn:'variant'，所以生产库里 80% 的行都是这一支）。
 * 之前这里只读了 `productTemplateId`，导致占绝大多数的 variant 规则打印出来
 * 商品名一片空白（20260907 实测发现：Standard Pricelist 73 全部 75 行商品名
 * 全是"—"）。
 */
function resolveProductId(item: OdooPricelistItem): string | undefined {
  if (item.applyOn === 'variant') return item.productVariantId
  if (item.applyOn === 'product') return item.productTemplateId
  return undefined
}

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const ids = searchParams.get('ids')?.split(',').filter(Boolean) ?? []

    const pricelists = ids.length > 0
      ? await prisma.odooPricelist.findMany({ where: { id: { in: ids } }, orderBy: { sequence: 'asc' } })
      : await prisma.odooPricelist.findMany({ where: { active: true }, orderBy: { sequence: 'asc' } })

    // formula 类型的规则可能嵌套引用别的价格表（formulaBase:'pricelist'），不管这次
    // 只打印哪几张，嵌套目标都要能查到，所以这里单独拉全量（同 lib/server-pricing.ts 的惯例）。
    const allPricelistsDb = await prisma.odooPricelist.findMany()
    const allPricelistsForEngine: OdooPricelistType[] = allPricelistsDb.map(p => ({
      id: p.id,
      externalId: p.externalId ?? undefined,
      name: p.name,
      currency: p.currency,
      items: (p.items as unknown as OdooPricelistType['items']) ?? [],
      sequence: p.sequence,
      selectable: p.selectable,
      active: p.active,
      updatedAt: p.updatedAt.toISOString(),
    }))

    // Collect all product ids referenced across all pricelist items (product 或 variant 两种 applyOn)
    const productIds = new Set<string>()
    for (const pl of pricelists) {
      const items = (pl.items as unknown as OdooPricelistItem[]) ?? []
      for (const item of items) {
        const pid = resolveProductId(item)
        if (pid) productIds.add(pid)
      }
    }

    // Fetch product names in one query
    const products = productIds.size > 0
      ? await prisma.product.findMany({
          where: { id: { in: [...productIds] } },
          select: {
            id: true, name: true, internalRef: true, saleDescription: true,
            listPrice: true, price: true, standardPrice: true, commissionPrice: true, categoryId: true,
            category: { select: { name: true, nameZh: true } },
          },
        })
      : []
    const productMap = new Map(products.map(p => [p.id, p]))
    const today = new Date().toISOString().slice(0, 10)

    // Pack Spec 列：ProductSaleUom.spec（"按这个单位卖，客户实际拿到的规格说明"，
    // 同 lib/order-line-description.ts 的取值口径）。价格表规则的 item.uomId 限定了
    // 具体单位就用那个单位的 spec，没限定（对该商品所有单位生效）就落回默认单位。
    const saleUoms = productIds.size > 0
      ? await prisma.productSaleUom.findMany({
          where: { productId: { in: [...productIds] } },
          select: { productId: true, uomId: true, spec: true, isDefault: true, factor: true },
        })
      : []
    // computeItemPrice 对 uomId 限定规则要按 ProductSaleUom.factor 把基准单位价换算到该单位
    // （lib/pricing-engine.ts getSaleUomFactor）。之前传给引擎的 product 没带 saleUoms，
    // factor 一律落回 1，按包/瓶限定的规则打印出整箱价（CHINA CHEF 3kg 打成 30.50，
    // 编辑页显示 9.50；20261030 客户反馈）。
    const saleUomsByProduct = new Map<string, { uomId: string; factor: number }[]>()
    for (const su of saleUoms) {
      const list = saleUomsByProduct.get(su.productId) ?? []
      list.push({ uomId: su.uomId, factor: toNum(su.factor) })
      saleUomsByProduct.set(su.productId, list)
    }
    const saleUomByExact = new Map(saleUoms.map(su => [`${su.productId}:${su.uomId}`, su.spec]))
    const saleUomByDefault = new Map(saleUoms.filter(su => su.isDefault).map(su => [su.productId, su.spec]))

    // Enrich items with product names
    const enriched = pricelists.map(pl => {
      // 20261017：标记不可售的规则不出现在打印/导出结果里——这是价格表的「输出」，
      // selectable=false 的规则当前不按这张表卖，不该出现在客户看到的报价单上。
      const items = ((pl.items as unknown as OdooPricelistItem[]) ?? []).filter(item => item.selectable !== false)
      const enrichedItems = items.map(item => {
        const pid = resolveProductId(item)
        const product = pid ? productMap.get(pid) : undefined

        // formula 类型（折扣→舍入→加价→利润夹取）只有算出来才有意义，之前打印页
        // fmtPrice() 没实现这支，一律吐 0.00——复用同一份计算逻辑（lib/pricing-engine.ts
        // 注释里明确要求：不能在别处照公式另抄一遍算法，见 20260913 对话记录）。
        let computedPrice: number | null = null
        if (product && item.computeType === 'formula') {
          const basePrice = toNum(product.listPrice ?? product.price ?? 0)
          const productForEngine = {
            id: product.id,
            listPrice: basePrice,
            standardPrice: toNumOpt(product.standardPrice),
            commissionPrice: toNumOpt(product.commissionPrice),
            categoryId: product.categoryId ?? undefined,
            saleUoms: saleUomsByProduct.get(product.id) ?? [],
          } as unknown as ProductType
          computedPrice = computeItemPrice(item, productForEngine, basePrice, allPricelistsForEngine, item.minQty || 1, today, 0, item.uomId)
        }

        const packSpec = pid
          ? (item.uomId ? saleUomByExact.get(`${pid}:${item.uomId}`) : undefined) ?? saleUomByDefault.get(pid) ?? null
          : null

        return {
          ...item,
          // global 规则本来就不锁定具体商品，"All Products" 不是缺数据，是这条规则的真实含义
          productName: item.applyOn === 'global'
            ? 'All Products'
            : pid ? (product?.name ?? pid) : null,
          productRef: pid ? (product?.internalRef ?? null) : null,
          // 打印分组用商品分类（20260913 改：Product.sequence 只有 31% 有值、且是 Odoo
          // 导入遗留的无规律编号，按它排跟不排没区别，见对话记录）；category 填充率 97.6%
          productCategory: product?.category?.name ?? null,
          productCategoryZh: product?.category?.nameZh ?? null,
          computedPrice,
          saleDescription: product?.saleDescription ?? null,
          packSpec: packSpec ?? null,
        }
      })
      return { ...serializeApi(pl), items: enrichedItems }
    })

    return NextResponse.json(enriched)
  } catch (error) {
    console.error('[GET /api/pricelists/print]', error)
    return NextResponse.json({ error: '获取价格表失败' }, { status: 500 })
  }
}
