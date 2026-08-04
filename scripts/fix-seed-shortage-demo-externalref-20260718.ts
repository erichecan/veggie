/**
 * scripts/fix-seed-shortage-demo-externalref-20260718.ts
 *
 * 给 Order.externalRef 加 @unique 之前的前置清理：生产库里唯一一组重复值是
 * externalRef='seed-shortage-demo'（18 条），来自缺货处理功能的演示/种子数据占位符，
 * 不是真实 Odoo 引用，直接置空即可（不影响这些订单本身的业务数据）。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/fix-seed-shortage-demo-externalref-20260718.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/fix-seed-shortage-demo-externalref-20260718.ts dotenv_config_path=.env.local --apply    # 实际写入
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

async function main() {
  const rows = await prisma.order.findMany({
    where: { externalRef: 'seed-shortage-demo' },
    select: { id: true, code: true, status: true, restaurantName: true },
  })
  console.log(`匹配到 externalRef='seed-shortage-demo' 的订单: ${rows.length} 条`)
  for (const r of rows) console.log(' ', JSON.stringify(r))

  if (!APPLY) { console.log('\n(dry-run，未写入。加 --apply 才会真正执行)'); return }

  const result = await prisma.order.updateMany({
    where: { externalRef: 'seed-shortage-demo' },
    data: { externalRef: null },
  })
  console.log(`\n✅ 已清空 ${result.count} 条订单的 externalRef`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
