import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertWaveNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { orderIds } = await req.json() as { orderIds: string[] }
      if (!orderIds?.length) {
        return NextResponse.json({ error: '请选择要分配的订单' }, { status: 400 })
      }

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      await assertWaveNotPickLocked(id)

      const orders = await prisma.order.findMany({
        where: { id: { in: orderIds } },
      })
      if (orders.length !== orderIds.length) {
        return NextResponse.json({ error: '部分订单不存在' }, { status: 400 })
      }

      // 可分配的入站状态：CONFIRMED（首次分配）或 WAVE_ASSIGNED（跨波次移动）。
      // 已出发(IN_DELIVERY)/已完成(COMPLETED)/未确认(PENDING) 不可分配。
      const notAssignable = orders.filter(o => o.status !== 'CONFIRMED' && o.status !== 'WAVE_ASSIGNED')
      if (notAssignable.length > 0) {
        return NextResponse.json({
          error: `以下订单状态无法分配（需为已确认或待分配）: ${notAssignable.map(o => o.code || o.id).join(', ')}`,
        }, { status: 400 })
      }

      const otherWaves = await prisma.pickingWave.findMany({
        where: {
          id: { not: id },
          orderIds: { hasSome: orderIds },
        },
      })
      for (const ow of otherWaves) {
        await assertWaveNotPickLocked(ow.id)
      }

      // 预先计算各波次的 zones（读操作放事务外），写操作再统一进事务保证原子。
      const otherWaveUpdates = await Promise.all(
        otherWaves.map(async (ow) => {
          const remaining = (ow.orderIds as string[]).filter(oid => !orderIds.includes(oid))
          return { id: ow.id, remaining, zones: await buildZonesByRestaurant(remaining) }
        }),
      )
      const merged = Array.from(new Set([...(wave.orderIds as string[]), ...orderIds]))
      const mergedZones = await buildZonesByRestaurant(merged)

      // 原子：从其他波次移除 + 并入本波次 + 回写订单状态（进入波次即 WAVE_ASSIGNED，
      // 仅升级 CONFIRMED，move 过来的 WAVE_ASSIGNED 保持不变，IN_DELIVERY/COMPLETED 不动）。
      const updated = await prisma.$transaction(async (tx) => {
        for (const u of otherWaveUpdates) {
          await tx.pickingWave.update({
            where: { id: u.id },
            data: { orderIds: u.remaining, zones: u.zones },
          })
        }
        const w = await tx.pickingWave.update({
          where: { id },
          data: { orderIds: merged, zones: mergedZones, assignmentDoneAt: null },
        })
        await tx.order.updateMany({
          where: { id: { in: orderIds }, status: 'CONFIRMED' },
          data: { status: 'WAVE_ASSIGNED' },
        })
        return w
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `分配 ${orderIds.length} 个订单到波次 ${wave.name}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      if (error instanceof WavePickLockedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/waves/[id]/assign]', error)
      return NextResponse.json({ error: '分配订单失败' }, { status: 500 })
    }
  })
}

async function buildZonesByRestaurant(orderIds: string[]) {
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
