import { prisma } from '@/lib/db'
import type { Prisma } from '@/lib/generated/prisma/client'

export interface ZoneItem {
  productId: string
  productName: string
  spec: string
  /** 行级备注（如"15个正常价+5个打折处理"），拣货时需要醒目提示 */
  note?: string
  image: string
  requiredQty: number
  pickedQty: number
  restaurants: string[]
  done: boolean
  uomName?: string
}

export interface Zone {
  name: string
  items: ZoneItem[]
}

/**
 * 按餐厅分组生成拣货分区快照（zones）。
 * 从 assign/unassign 路由中抽出的共享实现，供波次分配相关写入点复用（DRY）。
 */
export async function buildZonesByRestaurant(orderIds: string[]): Promise<Prisma.InputJsonValue> {
  if (orderIds.length === 0) return [] as Prisma.InputJsonValue

  const orders = await prisma.order.findMany({
    where: { id: { in: orderIds } },
  })

  const allProductIds = new Set<string>()
  for (const order of orders) {
    const items = (order.items as Array<{ productId: string }>) ?? []
    for (const item of items) allProductIds.add(item.productId)
  }

  const products = await prisma.product.findMany({
    where: { id: { in: Array.from(allProductIds) } },
    select: { id: true, images: true, templateId: true },
  })
  const templates = await prisma.productTemplate.findMany({
    where: { id: { in: products.map(p => p.templateId).filter(Boolean) as string[] } },
    select: { id: true, images: true, uom: { select: { name: true } } },
  })
  const templateImageMap = new Map(templates.map(t => [t.id, t.images[0] ?? '']))
  const templateUomMap = new Map(templates.map(t => [t.id, t.uom?.name ?? '']))
  const productImageMap = new Map(
    products.map(p => [
      p.id,
      p.images[0] ?? (p.templateId ? (templateImageMap.get(p.templateId) ?? '') : ''),
    ]),
  )
  const productUomMap = new Map(
    products.map(p => [p.id, p.templateId ? (templateUomMap.get(p.templateId) ?? '') : '']),
  )

  const zones: Zone[] = []

  for (const order of orders) {
    const items = (order.items as Array<{
      productId: string; productName: string; spec?: string; note?: string; quantity: number; uomName?: string
    }>) ?? []

    let zone = zones.find(z => z.name === order.restaurantName)
    if (!zone) {
      zone = { name: order.restaurantName, items: [] }
      zones.push(zone)
    }

    for (const item of items) {
      const existing = zone.items.find(i => i.productId === item.productId)
      if (existing) {
        existing.requiredQty += item.quantity
        // 同一商品多笔订单合并时，备注逐条拼接，不能因合并丢失任何一条
        if (item.note && item.note !== existing.note) {
          existing.note = existing.note ? `${existing.note}；${item.note}` : item.note
        }
      } else {
        zone.items.push({
          productId: item.productId,
          productName: item.productName,
          spec: item.spec ?? '',
          note: item.note || undefined,
          image: productImageMap.get(item.productId) ?? '',
          requiredQty: item.quantity,
          pickedQty: 0,
          restaurants: [order.restaurantName],
          done: false,
          uomName: item.uomName || productUomMap.get(item.productId) || undefined,
        })
      }
    }
  }

  zones.sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  for (const zone of zones) {
    zone.items.sort((a, b) => a.productName.localeCompare(b.productName, 'zh-CN'))
  }

  return zones as unknown as Prisma.InputJsonValue
}
