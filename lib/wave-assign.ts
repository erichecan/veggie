import { prisma } from '@/lib/db'
import { buildZonesByRestaurant } from '@/lib/wave-zones'

/**
 * 调度单一真相 = PickingWave.orderIds[]（P0-1）
 * ================================================================================
 * 「这单归谁送」只存在 wave 上。订单的归属(显示用批次/司机)一律由「包含该订单的 wave +
 * 实时 DriverSlot」派生,不再信任 Order.driverSlotId/deliveryBatch 的存量值。
 * 销售单改批次与调度台拖拽都经此处写 wave.orderIds,实现双向一致。
 * 见 docs/20260624-data-ownership-audit.md(P0-1)。
 */

export function dateOnlyUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

/** 从所有含该订单的 wave 移除(清空批次)。返回受影响 wave 数。 */
export async function removeOrderFromAllWaves(orderId: string): Promise<number> {
  const currentWaves = await prisma.pickingWave.findMany({ where: { orderIds: { has: orderId } } })
  const ops = []
  for (const w of currentWaves) {
    const remaining = (w.orderIds as string[]).filter((oid) => oid !== orderId)
    const zones = await buildZonesByRestaurant(remaining)
    ops.push(prisma.pickingWave.update({ where: { id: w.id }, data: { orderIds: remaining, zones } }))
  }
  if (ops.length) await prisma.$transaction(ops)
  return ops.length
}

/** 把订单分配到 (deliveryDate ?? 今天, driverSlot) 的 wave;不存在则建。保证一单至多属一个 wave。 */
export async function assignOrderToWave(
  orderId: string,
  driverSlotId: string,
): Promise<{ waveId: string; driverName: string } | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null
  const slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
  if (!slot) return null

  const waveDate = order.deliveryDate ? dateOnlyUTC(order.deliveryDate) : todayUTC()
  let wave = await prisma.pickingWave.findUnique({
    where: { waveDate_driverSlotId: { waveDate, driverSlotId } },
  })
  if (!wave) {
    const existing = await prisma.pickingWave.findMany({ where: { waveDate }, select: { waveNumber: true } })
    const nextNumber = existing.length > 0 ? Math.max(...existing.map((w) => w.waveNumber ?? 0)) + 1 : 1
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
  const otherWaves = await prisma.pickingWave.findMany({
    where: { id: { not: wave.id }, orderIds: { has: orderId } },
  })
  for (const ow of otherWaves) {
    const remaining = (ow.orderIds as string[]).filter((oid) => oid !== orderId)
    const zones = await buildZonesByRestaurant(remaining)
    ops.push(prisma.pickingWave.update({ where: { id: ow.id }, data: { orderIds: remaining, zones } }))
  }
  const merged = Array.from(new Set([...(wave.orderIds as string[]), orderId]))
  const targetZones = await buildZonesByRestaurant(merged)
  ops.push(prisma.pickingWave.update({ where: { id: wave.id }, data: { orderIds: merged, zones: targetZones } }))
  await prisma.$transaction(ops)

  return { waveId: wave.id, driverName: slot.driverName }
}

/**
 * 取一批订单的「所属 wave 派生批次显示」:orderId → "batchNum timeOfDay driverName"。
 * 用包含该订单的 wave 的 driverSlotId 关联**实时** DriverSlot(司机改名即时反映,不读 wave 快照名)。
 * 未进任何 wave 的订单不在返回 map 中(调用方回退到 Order 的下单意向显示)。
 */
export async function getOrderWaveDisplayMap(orderIds: string[]): Promise<Record<string, string>> {
  if (orderIds.length === 0) return {}
  const waves = await prisma.pickingWave.findMany({
    where: { orderIds: { hasSome: orderIds } },
    select: { orderIds: true, driverSlotId: true, driverName: true },
  })
  const slotIds = [...new Set(waves.map((w) => w.driverSlotId).filter((x): x is string => !!x))]
  const slots = slotIds.length
    ? await prisma.driverSlot.findMany({
        where: { id: { in: slotIds } },
        select: { id: true, batchNum: true, timeOfDay: true, driverName: true },
      })
    : []
  const slotMap = new Map(slots.map((s) => [s.id, s]))

  const idSet = new Set(orderIds)
  const map: Record<string, string> = {}
  for (const w of waves) {
    const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : undefined
    const label = slot ? `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}` : (w.driverName ?? '')
    if (!label) continue
    for (const oid of w.orderIds as string[]) {
      if (idSet.has(oid)) map[oid] = label
    }
  }
  return map
}
