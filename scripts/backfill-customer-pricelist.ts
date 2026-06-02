/**
 * scripts/backfill-customer-pricelist.ts
 *
 * 从 pic/res.partner.csv 回填客户默认价格表(pricelistId)。
 * 仅回填当前 pricelistId 为空、且 CSV 提供了可映射价格表的客户（不覆盖已有值）。
 *
 * 匹配规则：
 *   - CSV "External ID" = __export__.res_partner_<num>_<hash>，<num> 对应 DB Customer.externalId（纯数字）
 *   - CSV "Pricelist"   = 价格表 Odoo 外部ID，经 OdooPricelist.externalId 映射到本地 pl_xx
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/backfill-customer-pricelist.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-customer-pricelist.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')

function parseCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q
    } else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
}

async function main() {
  // 1) 价格表 externalId → 本地 id
  const pls = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true } })
  const plByExt = new Map<string, string>()
  for (const p of pls) if (p.externalId) plByExt.set(p.externalId, p.id)

  // 2) CSV：customer num → pricelist 本地 id
  const raw = fs.readFileSync(path.join(process.cwd(), 'pic/res.partner.csv'), 'utf-8')
  const lines = raw.split('\n').map(l => l.trim()).filter(Boolean)
  const csvMap = new Map<string, string>() // customerExternalId(num) → pricelistLocalId
  let csvRows = 0, csvWithPl = 0, csvUnmappable = 0
  for (const line of lines.slice(1)) {
    const cols = parseCSVLine(line)
    if (cols.length < 8) continue
    const extId = cols[0]?.trim() ?? ''
    const plExt = cols[7]?.trim() ?? ''
    const m = extId.match(/res_partner_(\d+)/)
    if (!m) continue
    csvRows++
    if (!plExt) continue
    csvWithPl++
    const localPl = plByExt.get(plExt)
    if (!localPl) { csvUnmappable++; continue }
    csvMap.set(m[1], localPl)
  }

  // 3) 找出当前 pricelistId 为空、CSV 有映射的客户
  const nullCusts = await prisma.customer.findMany({
    where: { pricelistId: null, NOT: { externalId: null } },
    select: { id: true, name: true, externalId: true },
  })
  const toUpdate: { id: string; name: string; pricelistId: string }[] = []
  for (const c of nullCusts) {
    const pl = c.externalId ? csvMap.get(c.externalId) : undefined
    if (pl) toUpdate.push({ id: c.id, name: c.name, pricelistId: pl })
  }

  console.log('── CSV 解析 ──')
  console.log(`  CSV 客户行: ${csvRows} | 含 Pricelist: ${csvWithPl} | 无法映射(默认表/未知): ${csvUnmappable} | 可映射: ${csvMap.size}`)
  console.log('── 回填目标 ──')
  console.log(`  当前 pricelistId 为空的客户: ${nullCusts.length}`)
  console.log(`  其中 CSV 有可映射价格表、可回填: ${toUpdate.length}`)
  console.log('  示例(前10):')
  for (const u of toUpdate.slice(0, 10)) console.log(`    ${u.name} (${u.id}) → ${u.pricelistId}`)

  // ABCT 抽查
  const abct = toUpdate.find(u => u.name.includes('ABCT'))
  console.log('  ABCT 抽查:', abct ? `${abct.name} → ${abct.pricelistId}` : '(未在回填列表)')

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入。加 --apply 实际执行。')
    return
  }

  console.log(`\n[APPLY] 开始回填 ${toUpdate.length} 个客户…`)
  const BATCH = 50
  let done = 0
  for (let i = 0; i < toUpdate.length; i += BATCH) {
    const batch = toUpdate.slice(i, i + BATCH)
    await Promise.all(batch.map(u =>
      prisma.customer.update({ where: { id: u.id }, data: { pricelistId: u.pricelistId } }),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toUpdate.length) console.log(`  …${done}/${toUpdate.length}`)
  }
  console.log(`✅ 完成：回填 ${done} 个客户的默认价格表`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
