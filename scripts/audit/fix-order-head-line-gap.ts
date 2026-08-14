/**
 * 订正订单表头金额与行小计的分叉（台账 X6）
 * ============================================================================
 * 成因见 X1~X4：编辑订单时表头按**前端提交价**算、行按定价引擎的权威价落库，
 * 提交价被拒时两者就此分叉。代码侧已修（表头改为按落库值求和），本脚本清存量。
 *
 * 订正方向：**以行为准，回填表头**。理由是行才是货真价实发出去的东西
 *（拣货单、送货单、核货都读行），表头那个数字自始至终没有任何单据用它算过。
 *
 * ⛔ 前置条件（脚本会自己检查，不满足就拒绝执行）：
 *   · 待订正的订单**不得已开出发票** —— 若发票按旧表头金额开过，改表头会让
 *     「发票 subtotalExTax == Σ订单额」这条不变量转红，那就不是改个数字能了结的事，
 *     得走贷记单/重开票，属业务决策
 *
 * 默认 dry-run，只打印将要做什么。真正写库要加 --apply。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/audit/fix-order-head-line-gap.ts
 *   npx tsx --env-file=.env.local scripts/audit/fix-order-head-line-gap.ts --apply
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const APPLY = process.argv.includes('--apply')
const prisma = createPrismaClient()
const eur = (n: unknown) => `€${Number(n ?? 0).toFixed(2)}`
const EPS = 0.011

async function main() {
  const grouped = await prisma.orderLine.groupBy({
    by: ['orderId'],
    _sum: { subtotal: true },
  })
  const lineSum = new Map(grouped.map(g => [g.orderId, Number(g._sum.subtotal ?? 0)]))

  const orders = await prisma.order.findMany({
    where: { id: { in: [...lineSum.keys()] } },
    select: { id: true, code: true, status: true, totalAmount: true, restaurantName: true },
  })

  const bad = orders
    .map(o => ({ ...o, lines: Math.round((lineSum.get(o.id) ?? 0) * 100) / 100 }))
    .filter(o => Math.abs(Number(o.totalAmount) - o.lines) > EPS)

  console.log(`\n扫描 ${orders.length} 张有行的订单，表头与行小计分叉 ${bad.length} 张\n`)
  if (bad.length === 0) { await prisma.$disconnect(); return }

  // 前置检查：开过票的不动
  const invoiced: string[] = []
  for (const o of bad) {
    const inv = await prisma.invoice.findFirst({
      where: { saleOrderIds: { has: o.id } },
      select: { name: true, status: true, subtotalExTax: true },
    })
    if (inv) invoiced.push(`${o.code} → ${inv.name}(${inv.status}, 税前 ${eur(inv.subtotalExTax)})`)
  }

  console.log('改前快照：')
  for (const o of bad) {
    console.log(
      `  ${o.code}  ${o.status}  ${o.restaurantName ?? ''}\n` +
      `      表头 ${eur(o.totalAmount)}  →  Σ行小计 ${eur(o.lines)}   ` +
      `(差 ${eur(Number(o.totalAmount) - o.lines)})`,
    )
  }

  if (invoiced.length > 0) {
    console.error(
      '\n⛔ 以下订单已开出发票，拒绝自动订正 —— 改表头会让「发票 == Σ订单额」转红，\n' +
      '   需要业务/财务先定怎么处理（贷记单？重开票？），不是改个数字的事：\n' +
      invoiced.map(s => `     · ${s}`).join('\n'),
    )
    await prisma.$disconnect()
    process.exit(1)
  }
  console.log('\n✓ 前置检查：这些订单均未开出发票，订正表头不会影响任何已开票据')

  if (!APPLY) {
    console.log('\n（dry-run，未写库。确认无误后加 --apply）')
    await prisma.$disconnect()
    return
  }

  for (const o of bad) {
    await prisma.order.update({ where: { id: o.id }, data: { totalAmount: o.lines } })
    console.log(`  ✅ ${o.code}: ${eur(o.totalAmount)} → ${eur(o.lines)}`)
  }

  // 改后复核：重新算一遍，不信刚才那次写入
  const after = await prisma.order.findMany({
    where: { id: { in: bad.map(o => o.id) } },
    select: { code: true, totalAmount: true, id: true },
  })
  let stillBad = 0
  for (const o of after) {
    const sum = Math.round((lineSum.get(o.id) ?? 0) * 100) / 100
    if (Math.abs(Number(o.totalAmount) - sum) > EPS) { stillBad++; console.error(`  ❌ ${o.code} 仍不一致`) }
  }
  console.log(stillBad === 0
    ? `\n✅ ${after.length} 张全部订正到位（改后逐张复核）`
    : `\n❌ 还有 ${stillBad} 张没对上`)

  await prisma.$disconnect()
  process.exit(stillBad === 0 ? 0 : 1)
}

main().catch(async e => { console.error(e); await prisma.$disconnect(); process.exit(1) })
