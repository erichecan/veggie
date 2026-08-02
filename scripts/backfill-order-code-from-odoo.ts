/**
 * 用 Odoo 原始单号回填 Order.code。
 *
 * 背景：14.8 万历史订单 Order.code 为 null，但界面用 `o.code ?? o.id.slice(-8)` 兜底显示，
 * 导致用户"看得见单号却搜不到"（docs/20260802-facet-dimension-data-readiness.md §5.1）。
 * 单号并未丢失——Order.externalRef 是 Odoo XML-ID（100% 填充），形如
 *   __export__.sale_order_152272_39df2088
 * 其中 152272 是 Odoo sale.order 主键，可经 scripts/odoo-migration/exports/sale_order_id_name.csv
 * 关联回真实单据号（D152258 这类）。所以是「找回」不是「造号」。
 *
 * 用法：
 *   npx tsx --env-file=.env.local scripts/backfill-order-code-from-odoo.ts          # 只读预演
 *   npx tsx --env-file=.env.local scripts/backfill-order-code-from-odoo.ts --fix    # 实际写入
 *
 * 安全性：
 * - 只写 code 为 null 的订单，已有 code 一律不动（幂等，可重复跑）
 * - Order.code 是 @unique，写入前先在内存里查重并剔除冲突
 * - 逐批小事务（Neon 单事务 5s 上限，大数组事务会 P2028 回滚）
 */
import { prisma } from '@/lib/db'
import { readFileSync } from 'node:fs'

const CSV = 'scripts/odoo-migration/exports/sale_order_id_name.csv'
const FIX = process.argv.includes('--fix')
const BATCH = 200

/** __export__.sale_order_152272_39df2088 → "152272" */
function odooIdOf(externalRef: string): string | null {
  const m = externalRef.match(/sale_order_(\d+)/)
  return m ? m[1] : null
}

function loadIdNameMap(): Map<string, string> {
  const lines = readFileSync(CSV, 'utf8').split('\n')
  const map = new Map<string, string>()
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const comma = line.indexOf(',')
    if (comma < 0) continue
    const id = line.slice(0, comma).trim()
    const name = line.slice(comma + 1).trim()
    if (id && name) map.set(id, name)
  }
  return map
}

async function main() {
  const idName = loadIdNameMap()
  console.log(`映射表 ${CSV}: ${idName.size} 条`)

  const targets = await prisma.order.findMany({
    where: { code: null, NOT: { externalRef: null } },
    select: { id: true, externalRef: true },
  })
  const totalNullCode = await prisma.order.count({ where: { code: null } })
  console.log(`code 为空的订单: ${totalNullCode}，其中有 externalRef 的: ${targets.length}`)

  const existing = await prisma.order.findMany({
    where: { NOT: { code: null } },
    select: { code: true },
  })
  const taken = new Set(existing.map(e => e.code as string))
  console.log(`已占用的 code: ${taken.size}`)

  const plan: { id: string; code: string }[] = []
  let noOdooId = 0, notInMap = 0, collideExisting = 0, collideWithin = 0
  const seen = new Set<string>()
  const samples: string[] = []

  for (const o of targets) {
    const oid = odooIdOf(o.externalRef!)
    if (!oid) { noOdooId++; continue }
    const name = idName.get(oid)
    if (!name) { notInMap++; continue }
    if (taken.has(name)) { collideExisting++; continue }
    if (seen.has(name)) { collideWithin++; continue }
    seen.add(name)
    plan.push({ id: o.id, code: name })
    if (samples.length < 5) samples.push(`  ${o.externalRef} → ${name}`)
  }

  console.log('\n=== 预演结果 ===')
  console.log(`可回填            : ${plan.length}`)
  console.log(`externalRef 无 id : ${noOdooId}`)
  console.log(`映射表中查不到    : ${notInMap}`)
  console.log(`与已有 code 冲突  : ${collideExisting}`)
  console.log(`本批内部重复      : ${collideWithin}`)
  console.log('\n样本:'); samples.forEach(s => console.log(s))

  if (!FIX) {
    console.log('\n（只读预演，未写入任何数据。加 --fix 执行回填）')
    return
  }

  console.log(`\n开始写入 ${plan.length} 条，每批 ${BATCH}（批量 SQL，非逐行 update）…`)
  let done = 0, failed = 0
  for (let i = 0; i < plan.length; i += BATCH) {
    const chunk = plan.slice(i, i + BATCH)
    // UPDATE ... FROM (VALUES ...) 一条语句改一批，避免 149k 次 Neon 往返。
    // 参数化占位符，不拼字符串；WHERE code IS NULL 保证幂等且绝不覆盖已有单号。
    const values = chunk.map((_, k) => `($${k * 2 + 1}, $${k * 2 + 2})`).join(',')
    const params = chunk.flatMap(c => [c.id, c.code])
    const sql = `UPDATE "Order" AS o SET code = v.code
                 FROM (VALUES ${values}) AS v(id, code)
                 WHERE o.id = v.id AND o.code IS NULL`
    try {
      const n = await prisma.$executeRawUnsafe(sql, ...params)
      done += n
    } catch (e) {
      failed += chunk.length
      if (failed <= BATCH * 3) console.error(`  ✖ 批 ${i}: ${(e as Error).message.split('\n')[0]}`)
    }
    if ((i / BATCH) % 50 === 0 || i + BATCH >= plan.length) {
      console.log(`  ${Math.min(i + BATCH, plan.length)}/${plan.length}  已写 ${done} 失败 ${failed}`)
    }
  }
  console.log(`\n完成：写入 ${done}，失败 ${failed}`)

  const remain = await prisma.order.count({ where: { code: null } })
  console.log(`复查：code 仍为空的订单 ${remain}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
