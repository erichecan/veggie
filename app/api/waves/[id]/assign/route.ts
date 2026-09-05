import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { assertWaveNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'
import { assertWaveNotDispatched, WaveDispatchedError } from '@/lib/wave-dispatch-lock'
import { removeOrderFromPalletsInWave, putOrderIntoPallet } from '@/lib/wave-assign'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      // driverSlotId 可选:调度台托盘视图拖拽会带上目标托盘(该 driverSlot 的 batchNum),
      // 把订单整单落进这个波次下对应的 Pallet;不传则只并入 wave.orderIds,不动托盘归属
      // (兼容旧调用/整卡拖入场景)。
      const { orderIds, driverSlotId } = await req.json() as { orderIds: string[]; driverSlotId?: string | null }
      if (!orderIds?.length) {
        return NextResponse.json({ error: '请选择要分配的订单' }, { status: 400 })
      }

      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      await assertWaveNotPickLocked(id)
      await assertWaveNotDispatched(id)

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
        await assertWaveNotDispatched(ow.id)
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

      // 托盘子分组：拖进了具体某个托盘(driverSlotId=该托盘的 batchNum 对应的 DriverSlot)时,
      // 把这些订单整单落进那个 Pallet;没带 driverSlotId(如整卡拖入)则只并入波次,不动托盘。
      // slot 校验放事务外(纯读+参数校验，失败不该产生任何写入)。
      let slot: { id: string; batchNum: number; driverName: string; timeOfDay: string } | null = null
      if (driverSlotId) {
        slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
        if (!slot) return NextResponse.json({ error: '托盘不存在' }, { status: 400 })
        if (slot.driverName !== wave.driverName || slot.timeOfDay !== wave.timeOfDay) {
          return NextResponse.json({ error: '托盘与目标批次的司机/时段不匹配' }, { status: 400 })
        }
      }

      // 原子：从其他波次移除 + 并入本波次 + 回写订单状态 + 落盘到具体托盘。
      // wave.orderIds 的更新和 Pallet.items 的写入必须在同一个事务里——分开提交曾经在中间
      // 夹一次失败，留下"订单已不在/已并入 orderIds、行数据却没跟着搬"的孤儿态
      // (2026-09-05 生产事故，订正见 scripts/fix-orphan-and-duplicate-wave-20260906.ts)。
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
        // 分配即回写订单交货日期=波次排程日,保持「订单 deliveryDate ⟺ 所在波次 waveDate」一致
        // (否则销售单列表按 deliveryDate 计数与配送中心按 wave.orderIds 计数对不上)。
        // 与「确认出发」(dispatch)同口径,只是提前到分配阶段。可分配订单均未出发、尚无 deliverySlip,
        // 故此处只回写 Order.deliveryDate;slip 在出发时才建并带上正确日期。
        if (wave.waveDate) {
          await tx.order.updateMany({
            where: { id: { in: orderIds }, status: { in: ['CONFIRMED', 'WAVE_ASSIGNED'] } },
            data: { deliveryDate: wave.waveDate },
          })
        }
        if (slot) {
          for (const ow of otherWaves) {
            for (const orderId of orderIds) await removeOrderFromPalletsInWave(ow.id, orderId, tx)
          }
          for (const order of orders) {
            await removeOrderFromPalletsInWave(id, order.id, tx)
            await putOrderIntoPallet(id, slot.batchNum, order, tx)
          }
        }
        return w
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `分配 ${orderIds.length} 个订单到波次 ${wave.name}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      if (error instanceof WavePickLockedError || error instanceof WaveDispatchedError) {
        return NextResponse.json({ error: error.message }, { status: 409 })
      }
      console.error('[PUT /api/waves/[id]/assign]', error)
      return NextResponse.json({ error: '分配订单失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
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
    select: { id: true, images: true, uom: { select: { name: true } } },
  })
  const productImageMap = new Map(products.map(p => [p.id, p.images[0] ?? '']))
  const productUomMap = new Map(products.map(p => [p.id, p.uom?.name ?? '']))

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
