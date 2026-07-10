/**
 * 合并：历史遗留「同司机同时段」多条未出发 PickingWave（DEV-PLAN.md 第 6/8 节）。
 *
 * 背景：2026-07-09 起波次改为按「司机+时段」聚合（见 lib/wave-assign.ts 头部注释），今天起新建
 * 的波次不会再重复；但改造前就存在的历史波次（比如"1 am BAO"和"3 am BAO"各自一条波次）依然是
 * 分裂状态。诊断结果见 scripts/diagnose-duplicate-driver-waves.ts：48 组 / 149 条波次 / 38 个订单。
 *
 * 只处理该分组里 dispatchedAt/completedAt 均为空的波次（"未出发"子集）；分组里若混有已出发/已
 * 完成的波次，那些原样不动（Trip/提成已是既成事实，见 DEV-PLAN.md 第 6 节，绝不回溯合并）。
 *
 * 合并规则：
 *   1. 存活波次 = 该分组未出发子集里 waveNumber 最小（无编号则视为 +Infinity）、同值再比
 *      createdAt 最早的一条；其余波次的 orderIds 并入存活波次（去重）。
 *   2. 每条被合并波次自己已有的 Pallet（若已经历过新流程分配）按 seq 原样搬进存活波次对应
 *      Pallet（跨波次的订单互不重叠，理论上不会撞 productId，仍做防御性去重求和）。
 *   3. 被合并波次里「没有被自己 Pallet 覆盖到」的订单（新 Pallet 概念上线前分配的历史订单）：
 *      按该波次自身的 driverSlotId 反查 batchNum，整单落进存活波次对应 seq 的 Pallet；
 *      driverSlotId 已被删除/找不到时，订单仍并入 orderIds，只是不落盘到具体托盘（调度台会按
 *      "历史订单，未分托盘" 兜底桶展示，不会丢单）。
 *   4. 重算存活波次的 zones（拣货分区快照），删除被合并波次（级联删除其已搬空的 Pallet 行）。
 *   5. 若分组里任一未出发波次 pickLockedAt 非空（拣货中已锁定），整组跳过不合并，需人工确认。
 *
 *   npx tsx --env-file=.env.local scripts/merge-duplicate-driver-waves.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/merge-duplicate-driver-waves.ts --apply  # 实际合并
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient, Prisma } from '../lib/generated/prisma/client'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

type PalletItem = {
  orderId: string
  orderCode?: string
  restaurantId: string
  restaurantName: string
  productId: string
  productName: string
  qty: number
  uomName?: string
}

type WaveRow = {
  id: string
  name: string | null
  waveDate: Date | null
  driverName: string | null
  timeOfDay: string | null
  orderIds: Prisma.JsonValue
  driverSlotId: string | null
  waveNumber: number | null
  dispatchedAt: Date | null
  completedAt: Date | null
  pickLockedAt: Date | null
  createdAt: Date
}

function dedupeItems(items: PalletItem[]): PalletItem[] {
  const map = new Map<string, PalletItem>()
  for (const it of items) {
    const key = `${it.orderId}::${it.productId}`
    const prev = map.get(key)
    if (prev) prev.qty += it.qty
    else map.set(key, { ...it })
  }
  return [...map.values()]
}

function buildPalletItemsForOrder(order: {
  id: string
  code: string | null
  restaurantId: string
  restaurantName: string
  items: unknown
}): PalletItem[] {
  const lines = (order.items as Array<{ productId: string; productName: string; quantity: number; uomName?: string }>) ?? []
  return lines.map((it) => ({
    orderId: order.id,
    orderCode: order.code ?? undefined,
    restaurantId: order.restaurantId,
    restaurantName: order.restaurantName,
    productId: it.productId,
    productName: it.productName,
    qty: it.quantity,
    uomName: it.uomName,
  }))
}

/** 与 app/api/waves/[id]/assign/route.ts、lib/wave-zones.ts 同逻辑（脚本独立于 app 运行，不走 @/ 别名，本地内联一份）。 */
async function buildZonesByRestaurant(
  tx: Prisma.TransactionClient,
  orderIds: string[],
): Promise<Prisma.InputJsonValue> {
  if (orderIds.length === 0) return [] as Prisma.InputJsonValue

  const orders = await tx.order.findMany({ where: { id: { in: orderIds } } })

  const allProductIds = new Set<string>()
  for (const order of orders) {
    const items = (order.items as Array<{ productId: string }>) ?? []
    for (const item of items) allProductIds.add(item.productId)
  }

  const products = await tx.product.findMany({
    where: { id: { in: Array.from(allProductIds) } },
    select: { id: true, images: true, templateId: true },
  })
  const templates = await tx.productTemplate.findMany({
    where: { id: { in: products.map((p) => p.templateId).filter(Boolean) as string[] } },
    select: { id: true, images: true, uom: { select: { name: true } } },
  })
  const templateImageMap = new Map(templates.map((t) => [t.id, t.images[0] ?? '']))
  const templateUomMap = new Map(templates.map((t) => [t.id, t.uom?.name ?? '']))
  const productImageMap = new Map(
    products.map((p) => [p.id, p.images[0] ?? (p.templateId ? (templateImageMap.get(p.templateId) ?? '') : '')]),
  )
  const productUomMap = new Map(
    products.map((p) => [p.id, p.templateId ? (templateUomMap.get(p.templateId) ?? '') : '']),
  )

  const zones: Array<{
    name: string
    items: Array<{
      productId: string; productName: string; spec: string; image: string
      requiredQty: number; pickedQty: number; restaurants: string[]; done: boolean; uomName?: string
    }>
  }> = []

  for (const order of orders) {
    const items = (order.items as Array<{
      productId: string; productName: string; spec?: string; quantity: number; uomName?: string
    }>) ?? []

    let zone = zones.find((z) => z.name === order.restaurantName)
    if (!zone) {
      zone = { name: order.restaurantName, items: [] }
      zones.push(zone)
    }

    for (const item of items) {
      const existing = zone.items.find((i) => i.productId === item.productId)
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
  for (const zone of zones) zone.items.sort((a, b) => a.productName.localeCompare(b.productName, 'zh-CN'))

  return zones as unknown as Prisma.InputJsonValue
}

async function mergeGroup(key: string, openOnes: WaveRow[]) {
  const sorted = [...openOnes].sort((a, b) => {
    const an = a.waveNumber ?? Infinity
    const bn = b.waveNumber ?? Infinity
    if (an !== bn) return an - bn
    return a.createdAt.getTime() - b.createdAt.getTime()
  })
  const survivor = sorted[0]
  const rest = sorted.slice(1)

  console.log(`\n▶ ${key}`)
  console.log(`   存活：${survivor.id}  "${survivor.name}"  ${(survivor.orderIds as string[]).length} 单`)
  for (const w of rest) {
    console.log(`   并入：${w.id}  "${w.name}"  ${(w.orderIds as string[]).length} 单  driverSlotId=${w.driverSlotId ?? '(无)'}`)
  }

  if (!APPLY) return

  await prisma.$transaction(async (tx) => {
    const survivorPallets = await tx.pallet.findMany({ where: { waveId: survivor.id } })
    const survivorPalletBySeq = new Map(survivorPallets.map((p) => [p.seq, p]))
    const mergedOrderIds = new Set<string>(survivor.orderIds as string[])

    for (const w of rest) {
      const wOrderIds = (w.orderIds as string[]) ?? []
      for (const id of wOrderIds) mergedOrderIds.add(id)

      const wPallets = await tx.pallet.findMany({ where: { waveId: w.id } })
      const coveredOrderIds = new Set(wPallets.flatMap((p) => ((p.items as PalletItem[]) ?? []).map((it) => it.orderId)))

      for (const p of wPallets) {
        const items = (p.items as PalletItem[]) ?? []
        if (items.length === 0) continue
        const existing = survivorPalletBySeq.get(p.seq)
        if (existing) {
          const mergedItems = dedupeItems([...(existing.items as PalletItem[]), ...items])
          const updated = await tx.pallet.update({ where: { id: existing.id }, data: { items: mergedItems } })
          survivorPalletBySeq.set(p.seq, updated)
        } else {
          const created = await tx.pallet.create({ data: { waveId: survivor.id, seq: p.seq, items } })
          survivorPalletBySeq.set(p.seq, created)
        }
      }

      const uncovered = wOrderIds.filter((id) => !coveredOrderIds.has(id))
      if (uncovered.length > 0 && w.driverSlotId) {
        const slot = await tx.driverSlot.findUnique({ where: { id: w.driverSlotId } })
        if (slot) {
          const orders = await tx.order.findMany({ where: { id: { in: uncovered } } })
          const newItems = orders.flatMap(buildPalletItemsForOrder)
          const existing = survivorPalletBySeq.get(slot.batchNum)
          if (existing) {
            const mergedItems = dedupeItems([...(existing.items as PalletItem[]), ...newItems])
            const updated = await tx.pallet.update({ where: { id: existing.id }, data: { items: mergedItems } })
            survivorPalletBySeq.set(slot.batchNum, updated)
          } else {
            const created = await tx.pallet.create({ data: { waveId: survivor.id, seq: slot.batchNum, items: newItems } })
            survivorPalletBySeq.set(slot.batchNum, created)
          }
        } else {
          console.log(`   ⚠️  ${w.id} 的 driverSlotId=${w.driverSlotId} 已找不到对应 DriverSlot，${uncovered.length} 单未落盘到具体托盘（仍并入 orderIds）`)
        }
      } else if (uncovered.length > 0) {
        console.log(`   ⚠️  ${w.id} 无 driverSlotId，${uncovered.length} 单未落盘到具体托盘（仍并入 orderIds）`)
      }
    }

    const finalOrderIds = [...mergedOrderIds]
    const zones = await buildZonesByRestaurant(tx, finalOrderIds)
    await tx.pickingWave.update({ where: { id: survivor.id }, data: { orderIds: finalOrderIds, zones } })
    await tx.pickingWave.deleteMany({ where: { id: { in: rest.map((w) => w.id) } } })
  })

  console.log(`   ✅ 已合并，存活波次现有 ${new Set([...(survivor.orderIds as string[]), ...rest.flatMap((w) => w.orderIds as string[])]).size} 单`)
}

async function main() {
  const waves = await prisma.pickingWave.findMany({
    select: {
      id: true, name: true, waveDate: true, driverName: true, timeOfDay: true,
      orderIds: true, driverSlotId: true, waveNumber: true,
      dispatchedAt: true, completedAt: true, pickLockedAt: true, createdAt: true,
    },
    orderBy: [{ waveDate: 'asc' }, { driverName: 'asc' }, { timeOfDay: 'asc' }, { createdAt: 'asc' }],
  })

  const groups = new Map<string, WaveRow[]>()
  for (const w of waves) {
    if (!w.driverName || !w.timeOfDay || !w.waveDate) continue
    const key = `${w.waveDate.toISOString().slice(0, 10)}::${w.driverName}::${w.timeOfDay}`
    const list = groups.get(key) ?? []
    list.push(w)
    groups.set(key, list)
  }

  console.log(`\n=== 合并「同司机同时段」重复未出发波次 (${APPLY ? 'APPLY 实际合并' : 'DRY-RUN 只读'}) ===`)

  let mergedGroups = 0
  let skippedLocked = 0

  for (const [key, list] of groups) {
    const openOnes = list.filter((w) => !w.dispatchedAt && !w.completedAt)
    if (openOnes.length <= 1) continue

    const locked = openOnes.filter((w) => w.pickLockedAt)
    if (locked.length > 0) {
      skippedLocked++
      console.log(`\n⛔ 跳过 ${key} — ${locked.length} 条波次拣货中已锁定(pickLockedAt 非空)，需人工确认后单独处理`)
      continue
    }

    mergedGroups++
    await mergeGroup(key, openOnes)
  }

  console.log('\n—— 汇总 ——')
  console.log(`${APPLY ? '已合并' : '计划合并'} ${mergedGroups} 组`)
  if (skippedLocked > 0) console.log(`因拣货锁定跳过 ${skippedLocked} 组（未处理，需另行确认）`)
  if (!APPLY) console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
  else console.log('\n✅ 合并完成。\n')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
