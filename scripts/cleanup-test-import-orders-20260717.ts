/**
 * scripts/cleanup-test-import-orders-20260717.ts
 *
 * 清理 2026-07-14 上一次会话验证 Odoo 导入方案时留下的 100 笔测试订单
 * （externalRef LIKE 'test-import%'，客户名多为"TEST TEST"，状态 WAVE_ASSIGNED，
 * createdAt 全部是 2026-07-14 当天——因为这批测试用"导入执行时间"当了 createdAt，
 * 混进了近期真实活跃订单中间，导致销售中心订单列表默认按 createdAt 倒序排序时
 * 排到了最前面。用户已确认删除。
 *
 * 排查发现这 100 笔订单还被 13 个 PickingWave.orderIds 数组引用（wave 本身是数组存储，
 * 不是外键，删 Order 不会自动清掉 wave 里的 id，会留下悬空引用）：
 *   - 10 个 wave 全部由测试订单组成 → 直接删除整个 wave
 *   - 3 个 wave 里混了真实订单（cmrkoisjo 3中2个/cmre45ixj 21中20个/cmre45j5r 4中2个）
 *     → 只从 orderIds 数组里摘掉测试订单 id，wave 本身和其余真实订单保留
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/cleanup-test-import-orders-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/cleanup-test-import-orders-20260717.ts dotenv_config_path=.env.local --apply    # 实际删除
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

async function main() {
  const testOrders = await prisma.order.findMany({
    where: { externalRef: { startsWith: 'test-import' } },
    select: { id: true, code: true, restaurantName: true },
  })
  console.log(`待删除测试订单: ${testOrders.length} 笔`)
  const testIds = new Set(testOrders.map(o => o.id))

  const waves = await prisma.pickingWave.findMany({ select: { id: true, driverName: true, orderIds: true } })
  const affectedWaves = waves
    .map(w => {
      const ids = w.orderIds as string[]
      const remaining = ids.filter(id => !testIds.has(id))
      return { ...w, originalCount: ids.length, remaining }
    })
    .filter(w => w.remaining.length !== w.originalCount)

  const wavesToDelete = affectedWaves.filter(w => w.remaining.length === 0)
  const wavesToUpdate = affectedWaves.filter(w => w.remaining.length > 0)

  console.log(`\n受影响的 wave: ${affectedWaves.length} 个`)
  console.log(`  其中将被整体删除（清空后无剩余真实订单）: ${wavesToDelete.length} 个`)
  for (const w of wavesToDelete) console.log(`    - ${w.id}（${w.driverName}，原 ${w.originalCount} 单，全是测试单）`)
  console.log(`  其中只摘除测试单 id、保留真实订单: ${wavesToUpdate.length} 个`)
  for (const w of wavesToUpdate) console.log(`    - ${w.id}（${w.driverName}，原 ${w.originalCount} → 剩 ${w.remaining.length}）`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    await prisma.$disconnect()
    return
  }

  for (const w of wavesToUpdate) {
    await prisma.pickingWave.update({ where: { id: w.id }, data: { orderIds: w.remaining } })
  }
  console.log(`✅ 已更新 ${wavesToUpdate.length} 个 wave 的 orderIds`)

  if (wavesToDelete.length > 0) {
    const del = await prisma.pickingWave.deleteMany({ where: { id: { in: wavesToDelete.map(w => w.id) } } })
    console.log(`✅ 已删除 ${del.count} 个纯测试 wave`)
  }

  // OrderLine 有 onDelete: Cascade，删 Order 会自动带走行明细
  const delOrders = await prisma.order.deleteMany({ where: { id: { in: [...testIds] } } })
  console.log(`✅ 已删除 ${delOrders.count} 笔测试订单（及其行明细）`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
