/**
 * scripts/rebalance-test-import-pallets-20260714.ts
 *
 * 背景：scripts/import-test-orders-odoo-20260714.ts 用 round-robin 把 ~100 张测试订单分给
 * 5 个司机，但每个司机固定用同一个 DriverSlot(取 batchNum 最小的那个)，导致
 * assignOrderToWave() 把该司机当天所有订单都塞进了同一个托盘(Pallet seq=1)——
 * AFZAAL/am 19 单、ANDRIUS/am 17 单等全挤在一个托盘里，调度台司机卡片「订单视图」/
 * 「托盘视图」单个托盘块都要滚动一长条才能拖拽，体验很差。
 *
 * 真实调度不会把一趟车的 17-19 家餐馆全塞一个托盘——会按车辆装载量拆成几个托盘。
 * 本脚本把 2026-07-10 这批测试导入订单较多(>8单)的托盘，按 ~6 单一组重新分配到
 * 多个 DriverSlot 批次(优先复用/解封已有 batchNum，不够再新建，遵守
 * MAX_PALLETS_PER_DRIVER=5 上限)，写法与 assignOrderToWave 一致：
 * removeOrderFromPalletsInWave() 先清旧位置，putOrderIntoPallet() 再落新位置。
 *
 * 不改 wave.orderIds(司机归属不变，只是同一司机内部重新分托盘)，不改订单状态。
 *
 * 运行：
 *   npx tsx scripts/rebalance-test-import-pallets-20260714.ts            # dry-run
 *   npx tsx scripts/rebalance-test-import-pallets-20260714.ts --apply    # 实际写入
 */
import { prisma } from '../lib/db'
import { removeOrderFromPalletsInWave, putOrderIntoPallet } from '../lib/wave-assign'

const APPLY = process.argv.includes('--apply')
const WAVE_DATE = new Date('2026-07-10T00:00:00Z')
const CHUNK_SIZE = 6
const SPLIT_THRESHOLD = 8
const MAX_PALLETS_PER_DRIVER = 5

async function ensureSlot(driverName: string, timeOfDay: string, batchNum: number): Promise<string> {
  const existing = await prisma.driverSlot.findUnique({
    where: { timeOfDay_batchNum_driverName: { timeOfDay, batchNum, driverName } },
  })
  if (existing) {
    if (existing.archived) {
      if (!APPLY) { console.log(`    [dry-run] 解封 DriverSlot ${batchNum} ${timeOfDay} ${driverName}`); return existing.id }
      await prisma.driverSlot.update({ where: { id: existing.id }, data: { archived: false } })
      console.log(`    解封 DriverSlot ${batchNum} ${timeOfDay} ${driverName}`)
    }
    return existing.id
  }
  if (!APPLY) { console.log(`    [dry-run] 新建 DriverSlot ${batchNum} ${timeOfDay} ${driverName}`); return `dry-run-${batchNum}` }
  const created = await prisma.driverSlot.create({ data: { timeOfDay, batchNum, driverName } })
  console.log(`    新建 DriverSlot ${batchNum} ${timeOfDay} ${driverName}`)
  return created.id
}

async function main() {
  const waves = await prisma.pickingWave.findMany({
    where: { waveDate: WAVE_DATE },
    select: { id: true, driverName: true, timeOfDay: true, orderIds: true },
  })

  for (const wave of waves) {
    if (!wave.driverName || !wave.timeOfDay) continue
    if (wave.orderIds.length <= SPLIT_THRESHOLD) continue

    console.log(`\n=== ${wave.driverName}/${wave.timeOfDay}: ${wave.orderIds.length} 单，需要拆分 ===`)

    const chunks: string[][] = []
    for (let i = 0; i < wave.orderIds.length; i += CHUNK_SIZE) {
      chunks.push(wave.orderIds.slice(i, i + CHUNK_SIZE))
    }
    if (chunks.length > MAX_PALLETS_PER_DRIVER) {
      console.log(`  ⚠️ 需要 ${chunks.length} 个托盘，超过上限 ${MAX_PALLETS_PER_DRIVER}，改用更大的分组`)
      chunks.length = 0
      const bigChunkSize = Math.ceil(wave.orderIds.length / MAX_PALLETS_PER_DRIVER)
      for (let i = 0; i < wave.orderIds.length; i += bigChunkSize) {
        chunks.push(wave.orderIds.slice(i, i + bigChunkSize))
      }
    }

    // 目标批次号就是 1..chunks.length——1 号本来就有(装了全部订单的那个托盘)，
    // 重新分配后它只会保留自己那一份，其余多出来的批次号缺 DriverSlot 就建/解封。
    const targetBatchNums = chunks.map((_, i) => i + 1)

    const orders = await prisma.order.findMany({
      where: { id: { in: wave.orderIds } },
      select: { id: true, code: true, restaurantId: true, restaurantName: true, items: true },
    })
    const orderMap = new Map(orders.map(o => [o.id, o]))

    for (let i = 0; i < chunks.length; i++) {
      const batchNum = targetBatchNums[i]
      const slotId = await ensureSlot(wave.driverName, wave.timeOfDay, batchNum)
      console.log(`  托盘 ${batchNum} (slot ${slotId}): ${chunks[i].length} 单`)
      if (!APPLY) continue
      for (const orderId of chunks[i]) {
        const order = orderMap.get(orderId)
        if (!order) continue
        await removeOrderFromPalletsInWave(wave.id, orderId)
        await putOrderIntoPallet(wave.id, batchNum, order)
      }
    }
  }

  console.log(APPLY ? '\n✅ 已应用' : '\n(dry-run，加 --apply 实际写入)')
}

main().finally(() => prisma.$disconnect())
