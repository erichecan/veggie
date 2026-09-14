import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import type { OdooPricelistItem } from '@/lib/types'

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
          select: { id: true, name: true, internalRef: true, category: { select: { name: true, nameZh: true } } },
        })
      : []
    const productMap = new Map(products.map(p => [p.id, p]))

    // Enrich items with product names
    const enriched = pricelists.map(pl => {
      const items = (pl.items as unknown as OdooPricelistItem[]) ?? []
      const enrichedItems = items.map(item => {
        const pid = resolveProductId(item)
        const product = pid ? productMap.get(pid) : undefined
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
