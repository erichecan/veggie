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
            id: true, name: true, internalRef: true,
            listPrice: true, price: true, standardPrice: true, commissionPrice: true, categoryId: true,
            category: { select: { name: true, nameZh: true } },
          },
        })
      : []
    const productMap = new Map(products.map(p => [p.id, p]))
    const today = new Date().toISOString().slice(0, 10)

    // Enrich items with product names
    const enriched = pricelists.map(pl => {
      const items = (pl.items as unknown as OdooPricelistItem[]) ?? []
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
          } as unknown as ProductType
          computedPrice = computeItemPrice(item, productForEngine, basePrice, allPricelistsForEngine, item.minQty || 1, today, 0, item.uomId)
        }

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
