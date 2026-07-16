/**
 * scripts/migrate-customer-pricelist-priority-20260715.ts
 *
 * 一次性迁移：把 Customer.pricelistId（单值，即将废弃）迁移成
 * CustomerPricelist{sequence:1}（客户挂载多价格表+优先级的第一步）。
 *
 * 幂等：跳过已经有 CustomerPricelist 记录的客户（可能是
 * backfill-customer-pricelist.ts 或本脚本之前已经处理过的）。
 *
 * 同时修正 3 个历史脏数据客户：priceType='pricelist'（非法枚举值，
 * 只有 multi/default/last 合法）→ 有挂价格表的改 multi，没挂的改 default。
 *
 * 运行：
 *   DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2) \
 *     npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts            # dry-run
 *   DATABASE_URL=$(grep "^DATABASE_URL" .env.local | cut -d'"' -f2) \
 *     npx tsx scripts/migrate-customer-pricelist-priority-20260715.ts --apply    # 实际写入
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  // ── 第一部分：pricelistId → CustomerPricelist{sequence:1} ──
  const customersWithPl = await prisma.customer.findMany({
    where: { pricelistId: { not: null } },
    select: { id: true, name: true, pricelistId: true, pricelists: { select: { id: true } } },
  })
  const toMigrate = customersWithPl.filter(c => c.pricelists.length === 0)
  const alreadyDone = customersWithPl.length - toMigrate.length

  console.log('── 价格表优先级迁移 ──')
  console.log(`  有 pricelistId 的客户: ${customersWithPl.length}`)
  console.log(`  已有 CustomerPricelist 记录（跳过）: ${alreadyDone}`)
  console.log(`  待迁移: ${toMigrate.length}`)

  // ── 第二部分：修 3 个 priceType='pricelist' 脏数据 ──
  const dirtyCustomers = await prisma.customer.findMany({
    where: { priceType: 'pricelist' },
    select: { id: true, name: true, pricelistId: true },
  })
  console.log(`\n── 脏数据 priceType='pricelist' ──`)
  console.log(`  待修正: ${dirtyCustomers.length}`)
  for (const c of dirtyCustomers) {
    const fixTo = c.pricelistId ? 'multi' : 'default'
    console.log(`    ${c.name} (${c.id}): pricelist → ${fixTo}（${c.pricelistId ? '有挂价格表' : '未挂价格表'}）`)
  }

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入。加 --apply 实际执行。')
    return
  }

  const BATCH = 8 // 2026-07-15 backfill-customer-pricelist.ts 在 BATCH=50 时触发 Neon P2028，此脚本同结构，提前调小并发
  let done = 0
  for (let i = 0; i < toMigrate.length; i += BATCH) {
    const batch = toMigrate.slice(i, i + BATCH)
    await Promise.all(batch.map(c =>
      prisma.customerPricelist.create({
        data: { customerId: c.id, pricelistId: c.pricelistId!, sequence: 1 },
      }),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toMigrate.length) console.log(`  …${done}/${toMigrate.length}`)
  }
  console.log(`✅ 迁移完成：${done} 个客户`)

  for (const c of dirtyCustomers) {
    const fixTo = c.pricelistId ? 'multi' : 'default'
    await prisma.customer.update({ where: { id: c.id }, data: { priceType: fixTo } })
  }
  console.log(`✅ 脏数据修正完成：${dirtyCustomers.length} 个客户`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
