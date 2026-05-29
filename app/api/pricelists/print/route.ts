import { NextRequest, NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import type { OdooPricelistItem } from '@/lib/types'

export async function GET(req: NextRequest) {
  try {
    const { searchParams } = new URL(req.url)
    const ids = searchParams.get('ids')?.split(',').filter(Boolean) ?? []

    const pricelists = ids.length > 0
      ? await prisma.odooPricelist.findMany({ where: { id: { in: ids } }, orderBy: { sequence: 'asc' } })
      : await prisma.odooPricelist.findMany({ where: { active: true }, orderBy: { sequence: 'asc' } })

    // Collect all productTemplateIds referenced across all pricelist items
    const templateIds = new Set<string>()
    for (const pl of pricelists) {
      const items = (pl.items as unknown as OdooPricelistItem[]) ?? []
      for (const item of items) {
        if (item.productTemplateId) templateIds.add(item.productTemplateId)
      }
    }

    // Fetch product names in one query
    const templates = templateIds.size > 0
      ? await prisma.productTemplate.findMany({
          where: { id: { in: [...templateIds] } },
          select: { id: true, name: true, internalRef: true },
        })
      : []
    const templateMap = new Map(templates.map(t => [t.id, t]))

    // Enrich items with product names
    const enriched = pricelists.map(pl => {
      const items = (pl.items as unknown as OdooPricelistItem[]) ?? []
      const enrichedItems = items.map(item => ({
        ...item,
        productName: item.productTemplateId
          ? (templateMap.get(item.productTemplateId)?.name ?? item.productTemplateId)
          : null,
        productRef: item.productTemplateId
          ? (templateMap.get(item.productTemplateId)?.internalRef ?? null)
          : null,
      }))
      return { ...serializeApi(pl), items: enrichedItems }
    })

    return NextResponse.json(enriched)
  } catch (error) {
    console.error('[GET /api/pricelists/print]', error)
    return NextResponse.json({ error: '获取价格表失败' }, { status: 500 })
  }
}
