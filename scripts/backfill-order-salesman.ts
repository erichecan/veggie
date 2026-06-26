/**
 * scripts/backfill-order-salesman.ts
 *
 * 回填 Order.salesman 业务员快照。
 * 背景:列表/报表已统一改读 Order.salesman 快照(下单时冻结),不再实时 join Customer.salesman。
 *      存量订单很多 salesman 为空(以前下单未填),改读快照后会显空,故一次性回填为当前客户业务员。
 *
 * 规则:仅回填 Order.salesman 为空(null/空串)、且其客户当前有 salesman 的订单(不覆盖已有快照)。
 *
 * 运行:
 *   node --import tsx -r dotenv/config scripts/backfill-order-salesman.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-order-salesman.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

async function main() {
  // 1) 取所有 salesman 为空的订单(含 restaurantId)
  const orders = await prisma.order.findMany({
    where: { OR: [{ salesman: null }, { salesman: '' }] },
    select: { id: true, code: true, restaurantId: true },
  })
  console.log(`[scan] salesman 为空的订单: ${orders.length}`)

  // 2) 批量取这些订单对应客户的当前 salesman
  const custIds = [...new Set(orders.map((o) => o.restaurantId))]
  const customers = await prisma.customer.findMany({
    where: { id: { in: custIds } },
    select: { id: true, salesman: true },
  })
  const salesmanByCust = new Map(customers.map((c) => [c.id, (c.salesman ?? '').trim()]))

  // 3) 仅回填客户当前有 salesman 的订单
  const toFill = orders
    .map((o) => ({ ...o, salesman: salesmanByCust.get(o.restaurantId) ?? '' }))
    .filter((o) => o.salesman.length > 0)

  console.log(`[plan] 可回填(客户有业务员): ${toFill.length} / 跳过(客户也无业务员): ${orders.length - toFill.length}`)

  if (!APPLY) {
    toFill.slice(0, 20).forEach((o) => console.log(`  ${o.code ?? o.id} → ${o.salesman}`))
    if (toFill.length > 20) console.log(`  …(其余 ${toFill.length - 20} 条略)`)
    console.log('\n[dry-run] 未写入。加 --apply 实际执行。')
    return
  }

  let done = 0
  for (const o of toFill) {
    await prisma.order.update({ where: { id: o.id }, data: { salesman: o.salesman.slice(0, 100) } })
    done++
    if (done % 200 === 0) console.log(`  …已回填 ${done}/${toFill.length}`)
  }
  console.log(`[apply] 完成,共回填 ${done} 条。`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
