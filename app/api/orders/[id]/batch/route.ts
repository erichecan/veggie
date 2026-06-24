import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { buildZonesByRestaurant } from '@/lib/wave-zones'

function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

function dateOnlyUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}

/**
 * 销售单列表分配/清空交货批次。
 * 单一存储 = PickingWave：本接口只写 wave.orderIds（不写 Order.driverSlotId/deliveryBatch）。
 * - driverSlotId 非空：归到 (订单 deliveryDate ?? 今天, driverSlot) 的 wave，没有则自动创建，再并入订单。
 * - driverSlotId 为空：从订单当前所属 wave 移除。
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const { driverSlotId } = (await req.json()) as { driverSlotId: string | null }

      const order = await prisma.order.findUnique({ where: { id } })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      // ── 清空：从订单当前所属的所有 wave 移除 ──
      if (!driverSlotId) {
        const currentWaves = await prisma.pickingWave.findMany({
          where: { orderIds: { has: id } },
        })
        const ops = []
        for (const w of currentWaves) {
          const remaining = (w.orderIds as string[]).filter(oid => oid !== id)
          const zones = await buildZonesByRestaurant(remaining)
          ops.push(prisma.pickingWave.update({ where: { id: w.id }, data: { orderIds: remaining, zones } }))
        }
        if (ops.length) await prisma.$transaction(ops)

        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'UPDATE', resource: 'order', resourceId: id,
          detail: `清空订单 ${order.code || id} 的交货批次`,
        })
        return NextResponse.json({ ok: true, driverSlotId: null })
      }

      // ── 分配：找/建 (waveDate, driverSlotId) 的 wave 并并入订单 ──
      const slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
      if (!slot) return NextResponse.json({ error: '司机批次不存在' }, { status: 400 })

      const waveDate = order.deliveryDate ? dateOnlyUTC(order.deliveryDate) : todayUTC()

      let wave = await prisma.pickingWave.findUnique({
        where: { waveDate_driverSlotId: { waveDate, driverSlotId } },
      })
      if (!wave) {
        const existing = await prisma.pickingWave.findMany({
          where: { waveDate },
          select: { waveNumber: true },
        })
        const nextNumber = existing.length > 0
          ? Math.max(...existing.map(w => w.waveNumber ?? 0)) + 1
          : 1
        const dateLabel = waveDate.toISOString().slice(0, 10)
        wave = await prisma.pickingWave.create({
          data: {
            name: `${dateLabel} #${nextNumber} ${slot.driverName}`,
            waveDate,
            waveNumber: nextNumber,
            waveType: slot.timeOfDay === 'pm' ? 'bulk' : 'loose',
            driverSlotId,
            driverName: slot.driverName,
            orderIds: [],
            zones: [],
            status: 'PENDING',
          },
        })
      }

      const ops = []
      // 从其他含该订单的 wave 剔除（保证一张订单至多属一个 wave）
      const otherWaves = await prisma.pickingWave.findMany({
        where: { id: { not: wave.id }, orderIds: { has: id } },
      })
      for (const ow of otherWaves) {
        const remaining = (ow.orderIds as string[]).filter(oid => oid !== id)
        const zones = await buildZonesByRestaurant(remaining)
        ops.push(prisma.pickingWave.update({ where: { id: ow.id }, data: { orderIds: remaining, zones } }))
      }
      // 并入目标 wave
      const merged = Array.from(new Set([...(wave.orderIds as string[]), id]))
      const targetZones = await buildZonesByRestaurant(merged)
      ops.push(prisma.pickingWave.update({ where: { id: wave.id }, data: { orderIds: merged, zones: targetZones } }))

      await prisma.$transaction(ops)

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order', resourceId: id,
        detail: `分配订单 ${order.code || id} 到批次 ${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`,
      })

      return NextResponse.json({ ok: true, driverSlotId, waveId: wave.id, driverName: slot.driverName })
    } catch (error) {
      console.error('[PUT /api/orders/[id]/batch]', error)
      return NextResponse.json({ error: '分配批次失败' }, { status: 500 })
    }
  })
}
