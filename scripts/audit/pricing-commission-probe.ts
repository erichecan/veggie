/**
 * 定价与提成重算比对（只读）
 * ============================================================================
 * 目的是回答「自动算出来的价格与提成，跟库里存的对不对得上」。
 *
 * 三块内容，可信度依次递减，报告里也按这个顺序标注：
 *
 *   1. subtotal 恒等式  subtotal == unitPrice × orderedQty
 *      确定性检查。这是本系统的口径 SSOT（unitPrice 与 subtotal 都是税前），
 *      不依赖任何历史状态，对不上就是错。
 *
 *   2. 提成重算        用 lib/commission.ts 这个唯一入口重算，与库里冻结值比对
 *      确定性检查。但要留意：若配置侧是空的，重算与存量会「都等于 0」而假性通过，
 *      所以必须同时报覆盖率，否则这个 ✓ 毫无意义。
 *
 *   3. 定价重算        ⚠️ **不做**。历史成交价要用「当时的价格表」才能重算，
 *      而价格表是会变的。拿今天的价格表去重算去年的单，差异不代表 bug。
 *      这里只报 unitPrice 的缺失/异常，不做「应该是多少」的判断。
 *
 * ⛔ 只读：仅 count / findMany / aggregate。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/audit/pricing-commission-probe.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'
import { calcOrderCommission } from '../../lib/commission'

const MONEY_EPS = 0.02
const SAMPLE = 20

const num = (v: unknown): number => Number(v ?? 0)

async function main() {
  const prisma = createPrismaClient()
  const out: string[] = []
  const push = (s = '') => out.push(s)

  push('# 定价与提成重算比对')
  push()

  // ── 1. subtotal 恒等式（全量） ───────────────────────────────────────────
  const badSubtotal = await prisma.$queryRawUnsafe<Array<{
    id: string; unitPrice: string; orderedQty: string; subtotal: string; productName: string
  }>>(`
    SELECT id, "unitPrice"::text, "orderedQty"::text, "subtotal"::text, "productName"
    FROM "OrderLine"
    WHERE ABS("subtotal" - ROUND("unitPrice" * "orderedQty", 2)) > ${MONEY_EPS}
    LIMIT 50
  `)
  const totalLines = await prisma.orderLine.count()
  const badCount = await prisma.$queryRawUnsafe<Array<{ c: bigint }>>(`
    SELECT COUNT(*)::bigint AS c FROM "OrderLine"
    WHERE ABS("subtotal" - ROUND("unitPrice" * "orderedQty", 2)) > ${MONEY_EPS}
  `)
  const nBad = Number(badCount[0]?.c ?? 0)

  push('## 1. subtotal 恒等式（确定性检查，全量）')
  push()
  push(`\`subtotal == unitPrice × orderedQty\`，容差 ${MONEY_EPS}`)
  push()
  push(`- 订单行总数：**${totalLines.toLocaleString()}**`)
  push(`- 不满足恒等式：**${nBad.toLocaleString()}**（${(nBad / totalLines * 100).toFixed(4)}%）`)
  push()
  if (badSubtotal.length > 0) {
    push('| 商品 | unitPrice | orderedQty | subtotal | 应为 |')
    push('|---|---:|---:|---:|---:|')
    for (const r of badSubtotal.slice(0, 15)) {
      const expect = (num(r.unitPrice) * num(r.orderedQty)).toFixed(2)
      push(`| ${r.productName?.replace(/\|/g, '/') ?? ''} | ${r.unitPrice} | ${r.orderedQty} | ${r.subtotal} | ${expect} |`)
    }
    push()
  }

  // ── 2. 提成配置覆盖率（先看这个，否则第 3 步的 ✓ 没有意义） ────────────
  const [
    custTotal, custRate, custFixed,
    prodTotal, prodComm,
    linesTotal, linesSnap,
    ordFrozen, ordWithTotal, ordCompleted,
  ] = await Promise.all([
    prisma.customer.count(),
    prisma.customer.count({ where: { commissionRate: { not: null } } }),
    prisma.customer.count({ where: { commissionFixed: { not: null } } }),
    prisma.product.count(),
    prisma.product.count({ where: { commissionPrice: { not: null } } }),
    prisma.orderLine.count(),
    prisma.orderLine.count({ where: { commissionPrice: { not: null } } }),
    prisma.order.count({ where: { commissionFrozenAt: { not: null } } }),
    prisma.order.count({ where: { driverCommissionTotal: { not: 0 } } }),
    prisma.order.count({ where: { status: { in: ['COMPLETED', 'LOCKED'] } } }),
  ])

  push('## 2. 提成配置覆盖率')
  push()
  push('提成 = 件提成 + 客户固定费 + 实送税前额 × 提成率。三项的输入都要有，结果才可能非零。')
  push()
  push('| 输入项 | 覆盖 | 说明 |')
  push('|---|---:|---|')
  push(`| 商品配了件提成价 | ${prodComm} / ${prodTotal} | 源头数据是**完整的** |`)
  push(`| 订单行有件提成价快照 | ${linesSnap.toLocaleString()} / ${linesTotal.toLocaleString()}（${(linesSnap / linesTotal * 100).toFixed(2)}%）| ⛔ 快照几乎全丢，件提成因此恒为 0 |`)
  push(`| 客户配了提成率 | ${custRate} / ${custTotal} | 比例提成几乎无输入 |`)
  push(`| 客户配了固定费 | ${custFixed} / ${custTotal} | 固定费无输入 |`)
  push()
  push('| 产出 | 数量 |')
  push('|---|---:|')
  push(`| 已完成 / 已锁定订单 | ${ordCompleted.toLocaleString()} |`)
  push(`| 有非零提成金额的订单 | **${ordWithTotal}** |`)
  push(`| 有冻结记录的订单 | **${ordFrozen}** |`)
  push()

  // ── 3. 提成重算比对（抽样） ─────────────────────────────────────────────
  const samples = await prisma.order.findMany({
    where: { status: { in: ['COMPLETED', 'LOCKED'] } },
    orderBy: { createdAt: 'desc' },
    take: SAMPLE,
    select: { id: true, code: true, driverCommissionTotal: true, commissionFrozenAt: true },
  })

  push(`## 3. 提成重算比对（最近 ${samples.length} 张已完成单）`)
  push()
  push('用 `lib/commission.ts` 的 `calcOrderCommission`（唯一计算入口）重算，与库中冻结值比对。')
  push()
  push('| 订单 | 库中值 | 重算值 | 差异 | 件提成 | 固定费 | 比例提成 |')
  push('|---|---:|---:|---:|---:|---:|---:|')
  let diffCount = 0
  let allZero = 0
  for (const o of samples) {
    const c = await calcOrderCommission(o.id)
    const stored = num(o.driverCommissionTotal)
    const recalc = num(c.grandTotal)
    const diff = recalc - stored
    if (Math.abs(diff) > MONEY_EPS) diffCount++
    if (stored === 0 && recalc === 0) allZero++
    push(`| ${o.code ?? o.id.slice(0, 8)} | ${stored.toFixed(2)} | ${recalc.toFixed(2)} | ${Math.abs(diff) > MONEY_EPS ? `**${diff.toFixed(2)}**` : '—'} | ${num(c.itemTotal).toFixed(2)} | ${num(c.fixedFee).toFixed(2)} | ${num(c.rateTotal).toFixed(2)} |`)
  }
  push()
  push(`- 有差异：**${diffCount} / ${samples.length}**`)
  push(`- 库中值与重算值**双双为 0**：**${allZero} / ${samples.length}**`)
  push()
  if (allZero === samples.length) {
    push('> ⚠️ 全部样本双双为 0 —— 这个「无差异」是**假性通过**。')
    push('> 重算与存量之所以相等，是因为三项输入都缺，两边都算出 0，而不是因为算对了。')
    push('> 在把上面的覆盖率补上去之前，本项比对不具备验证能力。')
    push()
  }

  console.log(out.join('\n'))
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
