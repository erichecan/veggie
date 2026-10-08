import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { resolvePrice, computeItemPrice } from '@/lib/pricing-engine'
import { ruleSummary } from '@/lib/pricelist-diff'
import type { OdooPricelist, OdooPricelistItem, Product } from '@/lib/types'

/**
 * GET /api/products/[id]/pricelist-rules —— 商品页「价格表」区块(20261008)
 * ============================================================================
 * 反查：哪些价格表里有规则作用在这个商品上(锁定这个商品 / 它所在的分类 / 全场)，
 * 每条规则算出来卖多少钱，每个价格表按引擎实际取价(数量 1、今天)最终是多少，
 * 以及有多少客户挂着这个价格表；再附上这个商品的价格规则改价历史
 * (lib/pricelist-rule-log.ts 写的 resource='pricelist-rule' 日志)。
 *
 * 价格算法全部复用 lib/pricing-engine.ts，不在这里另抄一份。
 */

const HISTORY_LIMIT = 100

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const raw = await prisma.product.findUnique({ where: { id } })
      if (!raw) return NextResponse.json({ error: '商品不存在' }, { status: 404 })
      const product = serializeApi(raw) as unknown as Product & { categoryId?: string | null }
      product.listPrice = product.listPrice != null ? Number(product.listPrice) : undefined
      product.standardPrice = product.standardPrice != null ? Number(product.standardPrice) : undefined

      const [pricelistsRaw, links, uoms, history] = await Promise.all([
        prisma.odooPricelist.findMany({ orderBy: { sequence: 'asc' } }),
        prisma.customerPricelist.groupBy({ by: ['pricelistId'], _count: { _all: true } }),
        prisma.uom.findMany({ select: { id: true, name: true } }),
        prisma.actionLog.findMany({
          where: { resource: 'pricelist-rule', resourceId: id },
          orderBy: { createdAt: 'desc' },
          take: HISTORY_LIMIT,
          select: { id: true, userName: true, detail: true, changes: true, createdAt: true },
        }),
      ])
      const allPricelists = serializeApi(pricelistsRaw) as unknown as OdooPricelist[]
      const customerCount = new Map(links.map(l => [l.pricelistId, l._count._all]))
      const uomName = new Map(uoms.map(u => [u.id, u.name]))
      const today = new Date().toISOString().slice(0, 10)
      const basePrice = product.listPrice ?? 0

      const pricelists = []
      for (const pl of allPricelists) {
        const items = Array.isArray(pl.items) ? pl.items : []
        const rules = items
          .filter((it: OdooPricelistItem) => {
            if (it.applyOn === 'variant') return (it.productVariantId || it.productTemplateId) === id
            if (it.applyOn === 'product') return (it.productTemplateId || it.productVariantId) === id
            if (it.applyOn === 'category') return !!it.categoryId && it.categoryId === product.categoryId
            return it.applyOn === 'global'
          })
          .sort((a, b) => a.sequence - b.sequence)
          .map(it => ({
            itemId: it.id,
            applyOn: it.applyOn,
            minQty: it.minQty ?? 0,
            dateStart: it.dateStart ?? null,
            dateEnd: it.dateEnd ?? null,
            uomName: it.uomId ? uomName.get(it.uomId) ?? it.uomId : null,
            computeType: it.computeType,
            summary: ruleSummary(it),
            price: computeItemPrice(it, product, basePrice, allPricelists, Math.max(1, it.minQty || 1), undefined, 0, it.uomId),
            expired: (!!it.dateEnd && today > it.dateEnd) || (!!it.dateStart && today < it.dateStart),
          }))
        // 只有全场规则的价格表也列出来(它确实决定这个商品的价)，但没有任何规则命中的不列
        if (rules.length === 0) continue
        const effective = resolvePrice(product, pl, allPricelists, 1)
        pricelists.push({
          id: pl.id,
          name: pl.name,
          active: pl.active,
          customerCount: customerCount.get(pl.id) ?? 0,
          effectivePrice: effective.isFallback ? null : effective.price,
          hasDirectRule: rules.some(r => r.applyOn === 'product' || r.applyOn === 'variant'),
          rules,
        })
      }
      // 直接锁定这个商品的价格表排前面，其余按价格表自身顺序
      pricelists.sort((a, b) => Number(b.hasDirectRule) - Number(a.hasDirectRule))

      return NextResponse.json({ listPrice: product.listPrice ?? null, pricelists, history: serializeApi(history) })
    } catch (error) {
      console.error('[GET /api/products/[id]/pricelist-rules]', error)
      return NextResponse.json({ error: '获取价格表规则失败' }, { status: 500 })
    }
  })
}
