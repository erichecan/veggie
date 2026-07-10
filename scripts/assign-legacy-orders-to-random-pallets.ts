/**
 * 把「历史订单，未分托盘」的订单随机塞进一个托盘（司机/波次不变，只补托盘号）。
 *
 * 背景：Pallet 概念(2026-07-09 见 DEV-PLAN.md)上线前分配的订单，只落在 wave.orderIds 里，
 * 没有对应的 Pallet.items——调度台会把这些订单单独列进"⚠️ 历史订单，未分托盘"兜底桶。这些订单
 * 已经在正确的波次(司机+时段)下，只是缺一个具体托盘号，用户确认只随机托盘号、司机不变。
 *
 * 对每条含未分托盘订单的波次：按该波次 driverName+timeOfDay 当天有效配置的 DriverSlot(托盘号)
 * 列表，给每个未分托盘订单随机挑一个，写入/合并进对应 Pallet.items。
 * 司机+时段完全没配置任何托盘的波次(如脏数据 "john/am" 大小写重复)跳过，单独报告，不瞎分配。
 *
 *   npx tsx --env-file=.env.local scripts/assign-legacy-orders-to-random-pallets.ts          # dry-run
 *   npx tsx --env-file=.env.local scripts/assign-legacy-orders-to-random-pallets.ts --apply  # 实际写入
 */
import 'dotenv/config'
import { neonConfig } from '@neondatabase/serverless'
import { PrismaNeon } from '@prisma/adapter-neon'
import { PrismaClient } from '../lib/generated/prisma/client'
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

function buildPalletItemsForOrder(order: {
  id: string; code: string | null; restaurantId: string; restaurantName: string; items: unknown
}): PalletItem[] {
  const lines = (order.items as Array<{ productId: string; productName: string; quantity: number; uomName?: string }>) ?? []
  return lines.map((it) => ({
    orderId: order.id, orderCode: order.code ?? undefined,
    restaurantId: order.restaurantId, restaurantName: order.restaurantName,
    productId: it.productId, productName: it.productName, qty: it.quantity, uomName: it.uomName,
  }))
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

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { orderIds: { isEmpty: false } },
    select: { id: true, name: true, waveDate: true, driverName: true, timeOfDay: true, orderIds: true },
    orderBy: { waveDate: 'asc' },
  })

  console.log(`\n=== 未分托盘订单随机分配托盘 (${APPLY ? 'APPLY 实际写入' : 'DRY-RUN 只读'}) ===\n`)

  let totalAssigned = 0
  let totalSkippedNoSlot = 0

  for (const w of waves) {
    const pallets = await prisma.pallet.findMany({ where: { waveId: w.id } })
    const covered = new Set(pallets.flatMap((p) => ((p.items as PalletItem[]) ?? []).map((it) => it.orderId)))
    const orderIds = w.orderIds as string[]
    const legacyIds = orderIds.filter((id) => !covered.has(id))
    if (legacyIds.length === 0) continue

    const date = w.waveDate ? w.waveDate.toISOString().slice(0, 10) : '?'
    const slots = await prisma.driverSlot.findMany({
      where: { driverName: w.driverName!, timeOfDay: w.timeOfDay!, archived: false },
      select: { batchNum: true },
      orderBy: { batchNum: 'asc' },
    })

    if (slots.length === 0) {
      totalSkippedNoSlot += legacyIds.length
      console.log(`⛔ 跳过 ${date} ${w.driverName}/${w.timeOfDay}（"${w.name}"）— 没有任何配置的托盘，${legacyIds.length} 单未分配`)
      continue
    }

    const orders = await prisma.order.findMany({ where: { id: { in: legacyIds } } })
    const bySeq = new Map(pallets.map((p) => [p.seq, p]))

    console.log(`▶ ${date} ${w.driverName}/${w.timeOfDay}（"${w.name}"）— ${legacyIds.length} 单，候选托盘 [${slots.map((s) => s.batchNum).join(', ')}]`)

    // 同一波次内按 seq 攒批量更新，避免同一托盘被并发覆盖写。
    const plannedBySeq = new Map<number, PalletItem[]>()
    for (const order of orders) {
      const seq = slots[Math.floor(Math.random() * slots.length)].batchNum
      const items = buildPalletItemsForOrder(order)
      plannedBySeq.set(seq, [...(plannedBySeq.get(seq) ?? []), ...items])
      console.log(`    ${order.code ?? order.id} → 托盘 ${seq}`)
      totalAssigned++
    }

    if (!APPLY) continue

    for (const [seq, newItems] of plannedBySeq) {
      const existing = bySeq.get(seq)
      if (existing) {
        const merged = dedupeItems([...(existing.items as PalletItem[]), ...newItems])
        await prisma.pallet.update({ where: { id: existing.id }, data: { items: merged } })
      } else {
        await prisma.pallet.create({ data: { waveId: w.id, seq, items: dedupeItems(newItems) } })
      }
    }
  }

  console.log('\n—— 汇总 ——')
  console.log(`${APPLY ? '已分配' : '计划分配'} ${totalAssigned} 单到随机托盘`)
  if (totalSkippedNoSlot > 0) console.log(`因司机+时段无配置托盘而跳过：${totalSkippedNoSlot} 单（需人工处理，如修正司机名大小写脏数据）`)
  if (!APPLY) console.log('\nDRY-RUN 结束，未写库。确认无误后加 --apply 执行。\n')
  else console.log('\n✅ 完成。\n')

  await prisma.$disconnect()
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
