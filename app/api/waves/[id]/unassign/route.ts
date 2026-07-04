import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { orderIds } = await req.json() as { orderIds: string[] }
      if (!orderIds?.length) {
        return NextResponse.json({ error: '请选择要移除的订单' }, { status: 400 })
      }

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })

      const remaining = (wave.orderIds as string[]).filter(oid => !orderIds.includes(oid))
      const zones = await buildZonesForOrders(remaining)

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { orderIds: remaining, zones, assignmentDoneAt: null },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `从波次 ${wave.name} 移除 ${orderIds.length} 个订单`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/unassign]', error)
      return NextResponse.json({ error: '移除订单失败' }, { status: 500 })
    }
  })
}

async function buildZonesForOrders(orderIds: string[]) {
  if (orderIds.length === 0) return []

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

  const zones: Array<{
    name: string
    items: Array<{
      productId: string; productName: string; spec: string; image: string
      requiredQty: number; pickedQty: number; restaurants: string[]; done: boolean
      uomName?: string
    }>
  }> = []

  for (const order of orders) {
    const items = (order.items as Array<{
      productId: string; productName: string; spec?: string; quantity: number; uomName?: string
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
      } else {
        zone.items.push({
          productId: item.productId,
          productName: item.productName,
          spec: item.spec ?? '',
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

  return zones
}
