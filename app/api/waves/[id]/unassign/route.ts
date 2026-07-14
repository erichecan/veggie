import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertWaveNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'
import { assertWaveNotDispatched, WaveDispatchedError } from '@/lib/wave-dispatch-lock'
import { removeOrderFromPalletsInWave } from '@/lib/wave-assign'

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
      await assertWaveNotPickLocked(id)
      await assertWaveNotDispatched(id)

      const remaining = (wave.orderIds as string[]).filter(oid => !orderIds.includes(oid))
      const zones = await buildZonesForOrders(remaining)

      // 原子：移出波次 + 回写订单状态（移出即退回 CONFIRMED，仅回退 WAVE_ASSIGNED，
      // 已出发(IN_DELIVERY)/已完成(COMPLETED) 不回退）。
      const updated = await prisma.$transaction(async (tx) => {
        const w = await tx.pickingWave.update({
          where: { id },
          data: { orderIds: remaining, zones, assignmentDoneAt: null },
        })
        // 移出波次即退回 CONFIRMED，deliveryDate 保留不清空：分配时已把它同步成了
        // 这个波次的 waveDate(见 assign 路由)，退回待分配后订单仍应留在"这一天"的待分配池里
        // 才能马上再分给别的司机——之前清空过，会导致订单从所有日期的待分配查询里彻底消失
        // (dateField=deliveryDate 的候选订单查询筛不到 null，也不再被任何 wave.orderIds 引用，
        // 前端两条补拉路径都够不着，订单"success 却消失")。与 deletePalletForDriverSlot
        // (删除托盘联动退回待分配)保持一致，那条路径本来就没清空过 deliveryDate。
        // 状态守卫确保只动未出发订单；未出发订单此时尚无 deliverySlip(出发才建)，故无需清 slip。
        await tx.order.updateMany({
          where: { id: { in: orderIds }, status: 'WAVE_ASSIGNED' },
          data: { status: 'CONFIRMED' },
        })
        return w
      })

      for (const orderId of orderIds) {
        await removeOrderFromPalletsInWave(id, orderId)
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `从波次 ${wave.name} 移除 ${orderIds.length} 个订单`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      if (error instanceof WavePickLockedError || error instanceof WaveDispatchedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
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
