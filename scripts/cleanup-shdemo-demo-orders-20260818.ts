/**
 * scripts/cleanup-shdemo-demo-orders-20260818.ts
 *
 * 清理 `SHDEMO-*` 演示订单 —— 2026-07-07 为了让「日销售管理中心 → 缺货处理」页面
 * 有数据可演示，用 prisma/seed-events/seed-shortage-demo.ts 往**生产库**补种的 18 张假单。
 * 客户在订单列表里看到这批单号后提出疑问，已确认清除（2026-08-18）。
 *
 * 为什么不用种子脚本自带的 `--clean`：
 *   那条回滚靠 `externalRef = 'seed-shortage-demo'` 这个标记找单，但生产库里这 18 张单的
 *   externalRef 现在**全是 NULL**（它们后来被当成真单排进了波次，标记在更新里被清掉了），
 *   状态也从 CONFIRMED 变成了 WAVE_ASSIGNED。所以只能按 code 前缀认。
 *
 * 会一并处理的牵连数据：
 *   - OrderLine / OrderAuditLog / DeliverySlip / OrderDiscrepancy —— schema 里是 onDelete: Cascade，
 *     删 Order 自动带走（脚本仍会先统计出数量，好让人知道删了多少）
 *   - StockMove —— **没有外键**，删单不会自动清。演示单确认时写了负数出库流水，
 *     删流水的同时必须把对应商品的 qtyOnHand 加回去，否则库存凭空少一批。
 *   - PickingWave.orderIds —— String[] 不是外键，同样不会自动清。
 *     全部由演示单组成的波次整体删除；混了真实单的只从数组里摘掉演示单 id。
 *
 * ⛔ 库存修正只动受影响的那些商品，用「减去被删流水的和」做增量修正。
 *    不要改用 prisma/seed-events/inventory.ts 的 recomputeOnHand —— 那是**全表**
 *    归零重算，生产库里本来就有历史不守恒的商品（db:validate 报过），一跑就会
 *    顺手改掉一大批与本次清理无关的库存数字。
 *
 * 运行（默认 dry-run，只读，不写任何东西）：
 *   npx tsx --env-file=.env.local scripts/cleanup-shdemo-demo-orders-20260818.ts
 *   npx tsx --env-file=.env.local scripts/cleanup-shdemo-demo-orders-20260818.ts --apply
 *
 * 生产（DigitalOcean droplet，宿主机 PostgreSQL 走 unix socket）：
 *   运行时镜像 veggie-app 里没有 prisma CLI 与驱动包，必须用 migrator 镜像：
 *     scp -P 2200 scripts/cleanup-shdemo-demo-orders-20260818.ts dev@167.99.86.19:/tmp/
 *     sudo docker compose -f /opt/veggie/docker-compose.yml --profile tools run --rm -T \
 *       -v /tmp/cleanup-shdemo-demo-orders-20260818.ts:/app/scripts/cleanup.ts \
 *       migrator npx tsx scripts/cleanup.ts            # 加 --apply 才真删
 */

import { createPrismaClient } from '@/lib/prisma-factory'
import { Prisma } from '@/lib/generated/prisma/client'

const prisma = createPrismaClient()

const CODE_PREFIX = 'SHDEMO-'
const APPLY = process.argv.includes('--apply')

const D = (v: Prisma.Decimal | number | string) => new Prisma.Decimal(v)
const money = (v: Prisma.Decimal) => v.toFixed(2)
const qty = (v: Prisma.Decimal) => v.toFixed(3)

async function main() {
  console.log(`\n=== SHDEMO 演示订单清理 · ${APPLY ? '执行模式 (--apply)' : 'DRY-RUN（只读）'} ===\n`)

  const orders = await prisma.order.findMany({
    where: { code: { startsWith: CODE_PREFIX } },
    select: {
      id: true, code: true, restaurantName: true, status: true,
      totalAmount: true, deliveryDate: true, createdAt: true, externalRef: true,
    },
    orderBy: { code: 'asc' },
  })

  if (orders.length === 0) {
    console.log('没有 code 以 SHDEMO- 开头的订单，无需清理。')
    await prisma.$disconnect()
    return
  }

  const ids = orders.map(o => o.id)
  const idSet = new Set(ids)

  // ── 1. 直接挂在订单上的记录（都是 Cascade，删单自动走）────────────────────
  const [lines, auditLogs, slips, discrepancies] = await Promise.all([
    prisma.orderLine.count({ where: { orderId: { in: ids } } }),
    prisma.orderAuditLog.count({ where: { orderId: { in: ids } } }),
    prisma.deliverySlip.count({ where: { orderId: { in: ids } } }),
    prisma.orderDiscrepancy.count({ where: { orderId: { in: ids } } }),
  ])

  // ── 2. 库存流水（无外键，必须显式删 + 修库存）──────────────────────────────
  const moves = await prisma.stockMove.findMany({
    where: { OR: [{ sourceId: { in: ids } }, { sourceRef: { startsWith: CODE_PREFIX } }] },
    select: { id: true, productId: true, productName: true, qty: true },
  })

  const perProduct = new Map<string, { name: string; sum: Prisma.Decimal; moves: number }>()
  for (const m of moves) {
    const cur = perProduct.get(m.productId) ?? { name: m.productName, sum: D(0), moves: 0 }
    cur.sum = cur.sum.plus(m.qty)
    cur.moves += 1
    perProduct.set(m.productId, cur)
  }

  const products = await prisma.product.findMany({
    where: { id: { in: [...perProduct.keys()] } },
    select: { id: true, name: true, qtyOnHand: true },
  })
  const stockPlan = products.map(p => {
    const agg = perProduct.get(p.id)!
    return {
      id: p.id,
      name: p.name,
      before: p.qtyOnHand,
      delta: agg.sum.negated(),           // 删掉的流水多是负数出库 → 库存要加回来
      after: D(p.qtyOnHand).minus(agg.sum),
      moves: agg.moves,
    }
  }).sort((a, b) => b.delta.abs().comparedTo(a.delta.abs()))

  const missingProducts = [...perProduct.keys()].filter(id => !products.some(p => p.id === id))

  // ── 3. 波次引用（String[]，无外键）─────────────────────────────────────────
  const waves = await prisma.pickingWave.findMany({ select: { id: true, name: true, orderIds: true, status: true } })
  const affectedWaves = waves
    .map(w => ({ ...w, remaining: w.orderIds.filter(id => !idSet.has(id)) }))
    .filter(w => w.remaining.length !== w.orderIds.length)
  const wavesToDelete = affectedWaves.filter(w => w.remaining.length === 0)
  const wavesToUpdate = affectedWaves.filter(w => w.remaining.length > 0)

  // ── 4. 对账单引用：碰到就停手（对账单是财务凭据，不能悄悄改）──────────────
  const statements = await prisma.statement.findMany({ select: { id: true, customerName: true, orderIds: true } })
  const affectedStatements = statements.filter(s => s.orderIds.some(id => idSet.has(id)))

  // ── 清单 ──────────────────────────────────────────────────────────────────
  const total = orders.reduce((s, o) => s.plus(o.totalAmount), D(0))
  console.log(`【订单】${orders.length} 张，金额合计 €${money(total)}`)
  for (const o of orders) {
    console.log(
      `  ${o.code}  ${o.status.padEnd(14)} €${money(D(o.totalAmount)).padStart(9)}  ` +
      `配送日 ${o.deliveryDate ? o.deliveryDate.toISOString().slice(0, 10) : '—'}  ${o.restaurantName}`,
    )
  }

  console.log(`\n【随订单级联删除】订单行 ${lines} · 审计日志 ${auditLogs} · 送货单 ${slips} · 拣货差异 ${discrepancies}`)

  console.log(`\n【库存流水】${moves.length} 条将删除，涉及 ${stockPlan.length} 个商品：`)
  for (const p of stockPlan) {
    console.log(
      `  ${p.name.slice(0, 46).padEnd(48)} ${p.moves} 条  ` +
      `${qty(D(p.before)).padStart(11)} → ${qty(p.after).padStart(11)}  (${p.delta.gte(0) ? '+' : ''}${qty(p.delta)})`,
    )
  }
  if (missingProducts.length > 0) {
    console.log(`  ⚠️ ${missingProducts.length} 个流水指向的商品已不存在，只删流水、无库存可修：${missingProducts.join(', ')}`)
  }

  console.log(`\n【拣货波次】受影响 ${affectedWaves.length} 个`)
  for (const w of wavesToDelete) console.log(`  整体删除（清完就空了）: ${w.name ?? w.id}  原 ${w.orderIds.length} 单，全是演示单`)
  for (const w of wavesToUpdate) console.log(`  只摘除演示单 id      : ${w.name ?? w.id}  原 ${w.orderIds.length} → 剩 ${w.remaining.length} 张真实单`)

  if (affectedStatements.length > 0) {
    console.log(`\n⛔ 有 ${affectedStatements.length} 张对账单引用了这些订单，已中止：`)
    for (const s of affectedStatements) console.log(`  ${s.id}  ${s.customerName}`)
    console.log('对账单是财务凭据，需先人工决定怎么处理，本脚本不动它。')
    await prisma.$disconnect()
    process.exit(1)
  }

  if (!APPLY) {
    console.log('\n(DRY-RUN，未写入任何数据。确认无误后加 --apply 执行)\n')
    await prisma.$disconnect()
    return
  }

  // ── 执行 ──────────────────────────────────────────────────────────────────
  console.log('\n开始执行…')
  await prisma.$transaction(async tx => {
    if (moves.length > 0) {
      await tx.stockMove.deleteMany({ where: { id: { in: moves.map(m => m.id) } } })
    }
    for (const p of stockPlan) {
      await tx.product.update({ where: { id: p.id }, data: { qtyOnHand: p.after } })
    }
    for (const w of wavesToUpdate) {
      await tx.pickingWave.update({ where: { id: w.id }, data: { orderIds: w.remaining } })
    }
    if (wavesToDelete.length > 0) {
      await tx.pickingWave.deleteMany({ where: { id: { in: wavesToDelete.map(w => w.id) } } })
    }
    await tx.order.deleteMany({ where: { id: { in: ids } } })
  }, { timeout: 120_000 })

  // ── 复查：只信删完之后重新查出来的数 ──────────────────────────────────────
  const [leftOrders, leftMoves, leftWaves, leftLines, leftSlips] = await Promise.all([
    prisma.order.count({ where: { code: { startsWith: CODE_PREFIX } } }),
    prisma.stockMove.count({ where: { OR: [{ sourceId: { in: ids } }, { sourceRef: { startsWith: CODE_PREFIX } }] } }),
    prisma.pickingWave.findMany({ select: { id: true, orderIds: true } })
      .then(ws => ws.filter(w => w.orderIds.some(id => idSet.has(id))).length),
    prisma.orderLine.count({ where: { orderId: { in: ids } } }),
    prisma.deliverySlip.count({ where: { orderId: { in: ids } } }),
  ])
  const after = await prisma.product.findMany({
    where: { id: { in: stockPlan.map(p => p.id) } },
    select: { id: true, name: true, qtyOnHand: true },
  })
  const stockMismatch = stockPlan.filter(p => {
    const now = after.find(a => a.id === p.id)
    return !now || !D(now.qtyOnHand).equals(p.after)
  })

  console.log('\n=== 复查 ===')
  console.log(`残留订单 ${leftOrders} · 残留流水 ${leftMoves} · 残留波次引用 ${leftWaves} · 残留订单行 ${leftLines} · 残留送货单 ${leftSlips}`)
  console.log(`库存与预期不符的商品：${stockMismatch.length} 个`)
  for (const p of stockMismatch) {
    const now = after.find(a => a.id === p.id)
    console.log(`  ⚠️ ${p.name}  预期 ${qty(p.after)}  实际 ${now ? qty(D(now.qtyOnHand)) : '(商品不存在)'}`)
  }

  const clean = leftOrders === 0 && leftMoves === 0 && leftWaves === 0 && leftLines === 0
    && leftSlips === 0 && stockMismatch.length === 0
  console.log(clean ? '\n✅ 清理完成，复查全绿。\n' : '\n❌ 复查未全绿，请人工检查上面的残留项。\n')
  await prisma.$disconnect()
  if (!clean) process.exit(1)
}

main().catch(e => { console.error(e); process.exit(1) })
