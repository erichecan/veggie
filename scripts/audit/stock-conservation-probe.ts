/**
 * 库存守恒体检（只读）
 * ============================================================================
 * db:validate 只回答「守不守恒」，答案是 0/1。但 895 个商品不守恒这个数字本身
 * 不构成决策依据 —— 要不要清洗、清洗谁、会不会越洗越糟，取决于**不守恒是怎么
 * 来的**。本脚本就是把那一个数字拆成可决策的几类：
 *
 *   A 有库存但一条流水都没有   → 导入时直接写 qtyOnHand 留下的历史债，
 *                                流水从来就不存在，不是算漏了
 *   B 有流水但对不上           → 出入库路径真的在漏，属于仍在发生的 bug
 *   C 无库存无流水但记为非零   → 脏写
 *
 * A 类只要补一笔期初流水就能对平，B 类补了也会继续漂 —— 先分清再动手。
 *
 * ⛔ 本脚本只读：只有 groupBy / findMany，没有任何写操作。
 *    可以安全指向生产副本。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/audit/stock-conservation-probe.ts
 */
import { createPrismaClient } from '../../lib/prisma-factory'

const QTY_EPS = 0.001
const n = (v: unknown): number => Number(v ?? 0)

interface Row {
  id: string
  name: string
  qtyOnHand: number
  sumMoves: number
  moveCount: number
  diff: number
  active: boolean
}

function classify(r: Row): 'A' | 'B' | 'C' {
  if (r.moveCount === 0 && r.qtyOnHand !== 0) return 'A'
  if (r.moveCount > 0) return 'B'
  return 'C'
}

function bucket(absDiff: number): string {
  if (absDiff < 1) return '< 1'
  if (absDiff < 10) return '1 ~ 10'
  if (absDiff < 100) return '10 ~ 100'
  if (absDiff < 1000) return '100 ~ 1000'
  return '>= 1000'
}

async function main() {
  const prisma = createPrismaClient()

  const [sums, counts, products] = await Promise.all([
    prisma.stockMove.groupBy({ by: ['productId'], _sum: { qty: true } }),
    prisma.stockMove.groupBy({ by: ['productId'], _count: { _all: true } }),
    prisma.product.findMany({ select: { id: true, name: true, qtyOnHand: true, active: true } }),
  ])

  const sumMap = new Map(sums.map(s => [s.productId, n(s._sum.qty)]))
  const cntMap = new Map(counts.map(c => [c.productId, c._count._all]))

  const bad: Row[] = []
  for (const p of products) {
    const sumMoves = sumMap.get(p.id) ?? 0
    const qtyOnHand = n(p.qtyOnHand)
    const diff = qtyOnHand - sumMoves
    if (Math.abs(diff) <= QTY_EPS) continue
    bad.push({
      id: p.id, name: p.name, qtyOnHand, sumMoves,
      moveCount: cntMap.get(p.id) ?? 0,
      diff,
      active: (p as { active?: boolean }).active !== false,
    })
  }

  const byClass = { A: [] as Row[], B: [] as Row[], C: [] as Row[] }
  for (const r of bad) byClass[classify(r)].push(r)

  const buckets = new Map<string, number>()
  for (const r of bad) buckets.set(bucket(Math.abs(r.diff)), (buckets.get(bucket(Math.abs(r.diff))) ?? 0) + 1)

  const totalDrift = bad.reduce((s, r) => s + Math.abs(r.diff), 0)
  const activeBad = bad.filter(r => r.active).length

  const out: string[] = []
  const push = (s = '') => out.push(s)

  push('# 库存守恒体检报告')
  push()
  push(`- 商品总数：**${products.length}**`)
  push(`- 库存流水条数：**${counts.reduce((s, c) => s + c._count._all, 0)}**（覆盖 ${counts.length} 个商品）`)
  push(`- 不守恒商品：**${bad.length}**（占 ${(bad.length / products.length * 100).toFixed(1)}%）`)
  push(`- 其中仍在售：**${activeBad}**`)
  push(`- 偏差绝对值合计：**${totalDrift.toFixed(3)}**`)
  push()
  push('## 分类（决定能不能清洗）')
  push()
  push('| 类别 | 含义 | 商品数 | 偏差合计 | 处理方式 |')
  push('|---|---|---:|---:|---|')
  const meta: Record<'A' | 'B' | 'C', [string, string]> = {
    A: ['有库存但一条流水都没有', '补一笔期初流水即可对平，属历史导入债'],
    B: ['有流水但对不上', '出入库路径仍在漏，**补流水没用，先修代码**'],
    C: ['无流水且库存为零却被判不守恒', '脏写，需个案核查'],
  }
  for (const k of ['A', 'B', 'C'] as const) {
    const rows = byClass[k]
    const drift = rows.reduce((s, r) => s + Math.abs(r.diff), 0)
    push(`| ${k} | ${meta[k][0]} | ${rows.length} | ${drift.toFixed(3)} | ${meta[k][1]} |`)
  }
  push()
  push('## 偏差量级分布')
  push()
  push('| 偏差绝对值 | 商品数 |')
  push('|---|---:|')
  for (const b of ['< 1', '1 ~ 10', '10 ~ 100', '100 ~ 1000', '>= 1000']) {
    if (buckets.has(b)) push(`| ${b} | ${buckets.get(b)} |`)
  }
  push()

  for (const k of ['B', 'A'] as const) {
    const rows = [...byClass[k]].sort((x, y) => Math.abs(y.diff) - Math.abs(x.diff)).slice(0, 20)
    if (rows.length === 0) continue
    push(`## ${k} 类偏差最大的 ${rows.length} 个`)
    push()
    push('| 商品 | qtyOnHand | Σ流水 | 偏差 | 流水条数 | 在售 |')
    push('|---|---:|---:|---:|---:|:-:|')
    for (const r of rows) {
      push(`| ${r.name.replace(/\|/g, '/')} | ${r.qtyOnHand} | ${r.sumMoves} | ${r.diff > 0 ? '+' : ''}${r.diff} | ${r.moveCount} | ${r.active ? '✓' : ''} |`)
    }
    push()
  }

  console.log(out.join('\n'))
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
