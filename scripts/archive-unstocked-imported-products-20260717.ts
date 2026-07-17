/**
 * scripts/archive-unstocked-imported-products-20260717.ts
 *
 * 本次(20260717)全量商品导入(import-odoo-products-full-20260717.ts)新建了 3,705 个商品，
 * 其中 2,362 个 Odoo 里本来就已归档(variant_active=f)，直接以 ARCHIVED 建的；剩下 1,343 个
 * Odoo 标为"可售"，按 variant_active=t 建成了 ACTIVE。但这 1,343 个商品此前从未进过 veggie
 * 系统，没有任何库存/销售记录，qtyOnHand 是 schema 默认值 0（本次导入刻意没有编造库存数据）。
 *
 * 副作用：这批商品以 ACTIVE+0 库存的身份出现在仓库页/下单页的"低库存"列表里，占了全库低库存
 * 告警数(2,884)的 46.6%，把运营真正需要关注的库存预警淹没了。用户确认（2026-07-17）改为
 * ARCHIVED：从在售/低库存视图里消失、不能被选中下新单，但历史订单里的商品名/行明细不受影响
 * （OrderLine 只依赖 productId 存在，不依赖 status）。以后要重新上架，改回 ACTIVE 即可撤销。
 *
 * 范围：只动"本次导入新建 + 当前 ACTIVE + qtyOnHand=0"这个精确交集（1,343 个），不碰
 * 生产库原有的、或 Phase 3c 之前就存在的任何商品，也不碰本次导入里本来就是 0 库存但已经
 * 有真实库存记录的老商品。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/archive-unstocked-imported-products-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/archive-unstocked-imported-products-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  const targets = await prisma.product.findMany({
    where: {
      status: 'ACTIVE',
      qtyOnHand: 0,
      template: { createdAt: { gte: new Date('2026-07-17T00:00:00Z') } },
    },
    select: { id: true, templateId: true, name: true },
  })
  console.log(`计划归档: ${targets.length} 个商品（ACTIVE → ARCHIVED，Product + ProductTemplate 同步）`)
  console.log('样例（前5个）:')
  for (const p of targets.slice(0, 5)) console.log(`  - ${p.name}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    await prisma.$disconnect()
    return
  }

  const productIds = targets.map(p => p.id)
  const templateIds = [...new Set(targets.map(p => p.templateId))]

  const r1 = await prisma.product.updateMany({ where: { id: { in: productIds } }, data: { status: 'ARCHIVED' } })
  const r2 = await prisma.productTemplate.updateMany({ where: { id: { in: templateIds } }, data: { status: 'ARCHIVED' } })
  console.log(`✅ 完成：Product ${r1.count} 条 / ProductTemplate ${r2.count} 条 已归档`)

  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
