import { prisma } from '@/lib/db'
import { buildZonesByRestaurant } from '@/lib/wave-zones'
import { assertWaveNotPickLocked } from '@/lib/wave-pick-lock'
import { assertWaveNotDispatched } from '@/lib/wave-dispatch-lock'
import type { Prisma } from '@/lib/generated/prisma/client'

/** 可传全局 prisma 或某个 $transaction 回调里的 tx——两处 Pallet 写入函数必须能挂进调用方的事务，
 * 不然 wave.orderIds 和 Pallet.items 就是两次独立提交，中间夹一次失败就会留下孤儿/残留数据
 * (2026-09-05 生产事故：订单从 wave.orderIds 消失但行数据卡在 Pallet.items 里,见事故订正脚本
 * scripts/fix-orphan-and-duplicate-wave-20260906.ts)。 */
type Db = Prisma.TransactionClient | typeof prisma

/**
 * 调度单一真相 = PickingWave.orderIds[]（P0-1）
 * ================================================================================
 * 「这单归谁送」只存在 wave 上。订单的归属(显示用批次/司机)一律由「包含该订单的 wave +
 * 实时 DriverSlot」派生,不再信任 Order.driverSlotId/deliveryBatch 的存量值。
 * 销售单改批次与调度台拖拽都经此处写 wave.orderIds,实现双向一致。
 * 见 docs/20260624-data-ownership-audit.md(P0-1)。
 *
 * 「批次号=托盘号，不是独立车次」改造（2026-07-09,见 DEV-PLAN.md）
 * ================================================================================
 * 波次现在按「司机+时段」聚合,不再按单个 DriverSlot(batchNum)各建一条——BAO 一个上午
 * 无论配了几个托盘(1/3/4),都汇总进同一个 wave,一趟车一个 Trip、一笔提成。
 * 「这单在这辆车的第几个托盘」这层信息波次分离没了之后必须有地方记,落在 Pallet.waveId+seq
 * 上(见 assignOrderToPallet/removeOrderFromPalletsInWave)——Pallet 模型原先写好但从未接前端,
 * 现在正好补上这个粒度,wave.orderIds 本身完全不受影响。
 */

export function dateOnlyUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()))
}
function todayUTC(): Date {
  const now = new Date()
  return new Date(Date.UTC(now.getFullYear(), now.getMonth(), now.getDate()))
}

/** 托盘内一条货物明细：来自某订单某餐馆的某商品。与 app/api/waves/[id]/pallets/route.ts 的 PalletItem 同形状。 */
export type PalletItem = {
  orderId: string
  orderCode?: string
  restaurantId: string
  restaurantName: string
  productId: string
  productName: string
  qty: number
  uomName?: string
}

/**
 * 把某订单从「某个波次下的所有托盘」里摘除(改派/重新码放/退回待分配前先清干净旧位置)。
 *
 * 摘除后如果这个托盘变空了,直接删掉这一行,而不是留一个 items=[] 的空壳——unassign/
 * pick-unlock/assign 改派等高频路径都走这里,不删的话空托盘会持续产生、越积越多
 * (2026-09-06 客户反馈：调度台一堆 0 orders 的托盘删不掉，生产库实测已积压 40 个)。
 * 空托盘本身没有意义:调度台的托盘 lane 是按 DriverSlot.batchNum 渲染的,找不到对应
 * Pallet 行就当空托盘显示(见 BatchTab.tsx palletOf)，删掉这行不影响 lane 继续显示。
 */
export async function removeOrderFromPalletsInWave(waveId: string, orderId: string, db: Db = prisma): Promise<void> {
  const pallets = await db.pallet.findMany({ where: { waveId } })
  for (const p of pallets) {
    const items = (p.items as PalletItem[]) ?? []
    if (!items.some((it) => it.orderId === orderId)) continue
    const remaining = items.filter((it) => it.orderId !== orderId)
    if (remaining.length === 0) {
      await db.pallet.delete({ where: { id: p.id } })
    } else {
      await db.pallet.update({ where: { id: p.id }, data: { items: remaining } })
    }
  }
}

/**
 * 把订单整单的商品行放进「这个波次下、seq=batchNum」的托盘(找不到就建)。
 * 一期按整单分配,不支持把同一单拆进多个托盘——拆单分盘是 app/api/waves/[id]/pallets 那套
 * 更细粒度的 PUT 接口负责的事,这里只保证「整单进对托盘」这个最基本的一致性。
 */
export async function putOrderIntoPallet(
  waveId: string,
  seq: number,
  order: { id: string; code: string | null; restaurantId: string; restaurantName: string; items: unknown },
  db: Db = prisma,
): Promise<void> {
  const lines = (order.items as Array<{ productId: string; productName: string; quantity: number; uomName?: string }>) ?? []
  const newItems: PalletItem[] = lines.map((it) => ({
    orderId: order.id,
    orderCode: order.code ?? undefined,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurantName,
    productId: it.productId,
    productName: it.productName,
    qty: it.quantity,
    uomName: it.uomName,
  }))
  const pallet = await db.pallet.findUnique({ where: { waveId_seq: { waveId, seq } } })
  if (pallet) {
    const others = ((pallet.items as PalletItem[]) ?? []).filter((it) => it.orderId !== order.id)
    await db.pallet.update({ where: { id: pallet.id }, data: { items: [...others, ...newItems] } })
  } else {
    await db.pallet.create({ data: { waveId, seq, items: newItems } })
  }
}

/** 从所有含该订单的 wave 移除(清空批次)。返回受影响 wave 数。 */
export async function removeOrderFromAllWaves(orderId: string): Promise<number> {
  const currentWaves = await prisma.pickingWave.findMany({ where: { orderIds: { has: orderId } } })
  for (const w of currentWaves) await assertWaveNotPickLocked(w.id)
  // zones 是纯读构建(不依赖本次事务内的写入结果),放事务外算完再传进去，事务内只做写入，
  // 缩短持锁时间。wave.orderIds 更新与 Pallet.items 清理必须在同一个事务里提交/回滚——
  // 分开两步曾经在中间夹一次失败，留下"订单已不在 orderIds、行数据却还卡在 Pallet.items"的
  // 孤儿态(2026-09-05 生产事故，订正见 scripts/fix-orphan-and-duplicate-wave-20260906.ts)。
  const zonesByWave = new Map<string, Prisma.InputJsonValue>()
  for (const w of currentWaves) {
    const remaining = (w.orderIds as string[]).filter((oid) => oid !== orderId)
    zonesByWave.set(w.id, await buildZonesByRestaurant(remaining))
  }
  await prisma.$transaction(async (tx) => {
    for (const w of currentWaves) {
      const remaining = (w.orderIds as string[]).filter((oid) => oid !== orderId)
      await tx.pickingWave.update({ where: { id: w.id }, data: { orderIds: remaining, zones: zonesByWave.get(w.id) } })
      await removeOrderFromPalletsInWave(w.id, orderId, tx)
    }
    // 移出波次即退回待分配:仅回退 WAVE_ASSIGNED→CONFIRMED(IN_DELIVERY/COMPLETED/PENDING 不动),
    // 与调度台 unassign 口径一致,避免"已移出但订单仍是 WAVE_ASSIGNED"的孤儿状态。
    await tx.order.updateMany({ where: { id: orderId, status: 'WAVE_ASSIGNED' }, data: { status: 'CONFIRMED' } })
  })
  return currentWaves.length
}

/**
 * 删除某个司机+时段+批次号(即调度台里的一个"托盘")时的联动清理：
 * 只影响**未出发**的当前波次(已出发/已完成的历史波次原样不动，那是既成事实的历史装车记录，
 * 不因为管理员事后删掉这个批次配置就改写)；把这个托盘里的订单整单退回待分配(与调度台拖拽
 * "删除托盘→订单回待分配"的确认交互一致)，托盘本身删除。
 *
 * 供 app/api/driver-slots/[id] 的 DELETE(归档 DriverSlot)调用，保证销售单下拉框的可选项
 * 和调度台的托盘 lane 两个入口——删掉一个批次配置后——两边同步消失，不留孤儿数据。
 */
export async function deletePalletForDriverSlot(slot: {
  driverName: string
  timeOfDay: string
  batchNum: number
}): Promise<{ unassignedOrderCount: number }> {
  const waves = await prisma.pickingWave.findMany({
    where: { driverName: slot.driverName, timeOfDay: slot.timeOfDay, dispatchedAt: null },
  })
  let unassignedOrderCount = 0
  for (const wave of waves) {
    const pallet = await prisma.pallet.findUnique({ where: { waveId_seq: { waveId: wave.id, seq: slot.batchNum } } })
    if (!pallet) continue
    const orderIdsInPallet = [...new Set(((pallet.items as PalletItem[]) ?? []).map((it) => it.orderId))]
    if (orderIdsInPallet.length > 0) {
      // 只有真的要把订单退回待分配、改动订单归属时才需要拦锁；空托盘删除不涉及任何订单，
      // 不该被同一司机+时段下、其他日期的已锁定波次误伤(实测反馈：空托盘一直报"已锁定"删不掉)。
      await assertWaveNotPickLocked(wave.id)
      const remaining = (wave.orderIds as string[]).filter((oid) => !orderIdsInPallet.includes(oid))
      const zones = await buildZonesByRestaurant(remaining)
      await prisma.$transaction([
        prisma.pickingWave.update({ where: { id: wave.id }, data: { orderIds: remaining, zones } }),
        prisma.order.updateMany({
          where: { id: { in: orderIdsInPallet }, status: 'WAVE_ASSIGNED' },
          data: { status: 'CONFIRMED' },
        }),
        prisma.pallet.delete({ where: { id: pallet.id } }),
      ])
      unassignedOrderCount += orderIdsInPallet.length
    } else {
      await prisma.pallet.delete({ where: { id: pallet.id } })
    }
  }
  return { unassignedOrderCount }
}

/**
 * 把订单分配到 (deliveryDate ?? 今天, 司机+时段) 的 wave,以及该 wave 下 batchNum 对应的托盘;
 * 不存在则建。保证一单至多属一个 wave、至多属一个托盘。
 *
 * 同一司机同一时段，未出发的波次只能有一条(应用层保证,见 schema.prisma PickingWave 注释)——
 * 不管调用方传进来的是哪个 batchNum 的 driverSlotId,都找/建同一个 wave,只是落进不同托盘。
 */
export async function assignOrderToWave(
  orderId: string,
  driverSlotId: string,
): Promise<{ waveId: string; driverName: string } | null> {
  const order = await prisma.order.findUnique({ where: { id: orderId } })
  if (!order) return null
  const slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
  if (!slot) return null

  const waveDate = order.deliveryDate ? dateOnlyUTC(order.deliveryDate) : todayUTC()
  let wave = await prisma.pickingWave.findFirst({
    where: { waveDate, driverName: slot.driverName, timeOfDay: slot.timeOfDay, dispatchedAt: null },
  })
  if (wave) await assertWaveNotPickLocked(wave.id)
  if (!wave) {
    const existing = await prisma.pickingWave.findMany({ where: { waveDate }, select: { waveNumber: true } })
    const nextNumber = existing.length > 0 ? Math.max(...existing.map((w) => w.waveNumber ?? 0)) + 1 : 1
    const dateLabel = waveDate.toISOString().slice(0, 10)
    try {
      wave = await prisma.pickingWave.create({
        data: {
          name: `${dateLabel} #${nextNumber} ${slot.driverName}`,
          waveDate,
          waveNumber: nextNumber,
          waveType: slot.timeOfDay === 'pm' ? 'bulk' : 'loose',
          driverSlotId,
          driverName: slot.driverName,
          timeOfDay: slot.timeOfDay,
          orderIds: [],
          zones: [],
          status: 'PENDING',
        },
      })
    } catch (e) {
      // 两个"分配到批次"请求前后脚(毫秒级)都读到"还没有波次"、都在建——数据库层的
      // 唯一索引(同司机+同时段+同日期,仅未出发波次)会拦下第二次 create。这不是真错误,
      // 重新查一次拿到并发那次建好的波次接着用即可,不然就是重复波次
      // (2026-09-05 生产事故:两个同一毫秒的分配请求各建了一条「#3 YANG」,其中一单被隔离进
      // 界面找不到的重复波次,订正见 scripts/fix-orphan-and-duplicate-wave-20260906.ts)。
      if ((e as { code?: string }).code !== 'P2002') throw e
      const raced = await prisma.pickingWave.findFirst({
        where: { waveDate, driverName: slot.driverName, timeOfDay: slot.timeOfDay, dispatchedAt: null },
      })
      if (!raced) throw e
      wave = raced
      await assertWaveNotPickLocked(wave.id)
    }
  }

  const otherWaves = await prisma.pickingWave.findMany({
    where: { id: { not: wave.id }, orderIds: { has: orderId } },
  })
  for (const ow of otherWaves) {
    await assertWaveNotPickLocked(ow.id)
    await assertWaveNotDispatched(ow.id)
  }
  // zones 是纯读构建，放事务外先算好；wave.orderIds 的更新和 Pallet.items 的写入必须在同一个
  // 事务里提交——分两步曾经在中间夹一次失败，留下"orderIds 干净、Pallet.items 残留"的孤儿态
  // (同上,2026-09-05 生产事故)。
  const otherZones = new Map<string, Prisma.InputJsonValue>()
  for (const ow of otherWaves) {
    const remaining = (ow.orderIds as string[]).filter((oid) => oid !== orderId)
    otherZones.set(ow.id, await buildZonesByRestaurant(remaining))
  }
  const merged = Array.from(new Set([...(wave.orderIds as string[]), orderId]))
  const targetZones = await buildZonesByRestaurant(merged)
  const finalWave = wave

  await prisma.$transaction(async (tx) => {
    for (const ow of otherWaves) {
      const remaining = (ow.orderIds as string[]).filter((oid) => oid !== orderId)
      await tx.pickingWave.update({ where: { id: ow.id }, data: { orderIds: remaining, zones: otherZones.get(ow.id) } })
      await removeOrderFromPalletsInWave(ow.id, orderId, tx)
    }
    // driverSlotId 快照随最近一次指派更新——一个波次现在可能横跨多个 batchNum,这个字段只作
    // "任取一个属于本波次的 DriverSlot"的兼容读兜底(打印/交接摘要等未接 Pallet 的旧消费方用),
    // 精确到"这单在第几个托盘"的口径一律走 Pallet,不读这个字段。
    await tx.pickingWave.update({ where: { id: finalWave.id }, data: { orderIds: merged, zones: targetZones, driverSlotId } })
    // 进入波次即 WAVE_ASSIGNED:仅升级 CONFIRMED(IN_DELIVERY/COMPLETED/PENDING 不动),
    // 与调度台 assign 口径一致,避免"已入批但订单仍是 CONFIRMED"导致销售单列表状态列不同步。
    await tx.order.updateMany({ where: { id: orderId, status: 'CONFIRMED' }, data: { status: 'WAVE_ASSIGNED' } })
    await removeOrderFromPalletsInWave(finalWave.id, orderId, tx)
    await putOrderIntoPallet(finalWave.id, slot.batchNum, order, tx)
  })

  return { waveId: wave.id, driverName: slot.driverName }
}

/**
 * 取一批订单「所属波次 + 所属托盘」的原始信息:orderId → {waveId, seq, driverName, timeOfDay}。
 * 一个波次现在可能横跨多个托盘,精确到"这单在第几个托盘"必须查 Pallet.items,不能再从
 * wave.driverSlotId 反推(那只是最近一次指派留下的兼容快照,不代表这单具体在哪个托盘)。
 * 未落进任何托盘的订单不在返回 map 中。
 */
async function getOrderPalletInfo(
  orderIds: string[],
): Promise<Record<string, { waveId: string; seq: number; driverName: string; timeOfDay: string }>> {
  if (orderIds.length === 0) return {}
  const idSet = new Set(orderIds)
  const waves = await prisma.pickingWave.findMany({
    where: { orderIds: { hasSome: orderIds } },
    select: { id: true, driverName: true, timeOfDay: true },
  })
  if (waves.length === 0) return {}
  const waveMap = new Map(waves.map((w) => [w.id, w]))
  const pallets = await prisma.pallet.findMany({ where: { waveId: { in: waves.map((w) => w.id) } } })

  const map: Record<string, { waveId: string; seq: number; driverName: string; timeOfDay: string }> = {}
  for (const p of pallets) {
    const w = waveMap.get(p.waveId)
    if (!w) continue
    const items = (p.items as PalletItem[]) ?? []
    for (const it of items) {
      if (idSet.has(it.orderId) && !map[it.orderId]) {
        map[it.orderId] = { waveId: p.waveId, seq: p.seq, driverName: w.driverName ?? '', timeOfDay: w.timeOfDay ?? '' }
      }
    }
  }
  return map
}

/**
 * 取一批订单的「所属托盘派生批次显示」:orderId → "seq timeOfDay driverName"。
 * 未进任何 wave 的订单不在返回 map 中(调用方回退到 Order 的下单意向显示)；
 * 进了 wave 但还没落进任何 Pallet 的极少数过渡期脏数据,退回只显示司机名,不编造托盘号。
 */
export async function getOrderWaveDisplayMap(orderIds: string[]): Promise<Record<string, string>> {
  if (orderIds.length === 0) return {}
  const info = await getOrderPalletInfo(orderIds)
  const map: Record<string, string> = {}
  for (const [oid, p] of Object.entries(info)) {
    if (!p.driverName) continue
    map[oid] = `${p.seq} ${p.timeOfDay} ${p.driverName}`
  }
  if (Object.keys(map).length < orderIds.length) {
    const idSet = new Set(orderIds)
    const waves = await prisma.pickingWave.findMany({
      where: { orderIds: { hasSome: orderIds } },
      select: { orderIds: true, driverName: true },
    })
    for (const w of waves) {
      for (const oid of w.orderIds as string[]) {
        if (idSet.has(oid) && !map[oid] && w.driverName) map[oid] = w.driverName
      }
    }
  }
  return map
}

/**
 * 把一批订单的 deliveryBatchDisplay 就地覆写成实时 wave 派生值(SSOT P0-1)。
 * 与 app/api/orders/route.ts 内的同名局部函数逻辑一致，这里导出一份供其它只读消费方
 * （如 CSV 导出）复用，避免各处各写一份「司机显示」覆写逻辑。
 */
export async function attachWaveDisplay<T extends { id: string; deliveryBatchDisplay?: string | null }>(orders: T[]): Promise<T[]> {
  const map = await getOrderWaveDisplayMap(orders.map((o) => o.id))
  for (const o of orders) {
    if (map[o.id]) o.deliveryBatchDisplay = map[o.id]
  }
  return orders
}

/**
 * 取一批订单的「所属托盘对应的 DriverSlot.id」:orderId → driverSlotId。
 * 与 getOrderWaveDisplayMap 同源(托盘是调度精确到批次号的唯一真相),供编辑态下拉框预选,
 * 保证「编辑时预选的司机+批次」= 「显示的司机+批次」,不再读 Order.driverSlotId 的下单意向存量。
 * 未进任何 wave / 未落进任何托盘的订单不在返回 map 中(调用方回退到 Order.driverSlotId)。
 */
export async function getOrderWaveDriverSlotMap(orderIds: string[]): Promise<Record<string, string>> {
  if (orderIds.length === 0) return {}
  const info = await getOrderPalletInfo(orderIds)
  const entries = Object.entries(info)
  if (entries.length === 0) return {}

  const comboMap = new Map<string, { driverName: string; timeOfDay: string; seq: number }>()
  for (const [, p] of entries) {
    if (!p.driverName || !p.timeOfDay) continue
    comboMap.set(`${p.driverName}::${p.timeOfDay}::${p.seq}`, { driverName: p.driverName, timeOfDay: p.timeOfDay, seq: p.seq })
  }
  const combos = [...comboMap.values()]
  if (combos.length === 0) return {}
  const slots = await prisma.driverSlot.findMany({
    where: { OR: combos.map((c) => ({ driverName: c.driverName, timeOfDay: c.timeOfDay, batchNum: c.seq })) },
  })
  const slotKey = (driverName: string, timeOfDay: string, batchNum: number) => `${driverName}::${timeOfDay}::${batchNum}`
  const slotIdMap = new Map(slots.map((s) => [slotKey(s.driverName, s.timeOfDay, s.batchNum), s.id]))

  const map: Record<string, string> = {}
  for (const [oid, p] of entries) {
    const id = slotIdMap.get(slotKey(p.driverName, p.timeOfDay, p.seq))
    if (id) map[oid] = id
  }
  return map
}
