/**
 * scripts/backfill-customer-pricelist.ts
 *
 * 从 pic/res.partner.csv（Odoo Customers 列表 Action→Export，"customer pricelist" 已保存字段模板 + import-compatible）
 * 回填客户价格表优先级第一位（CustomerPricelist.sequence=1）。
 *
 * 2026-07-15 改版：适配新导出的技术字段名表头(id/name/property_product_pricelist/id...)；
 * 同日第二次改版：Customer.pricelistId 即将废弃，改为写入新表 CustomerPricelist(sequence=1)。
 * 写入范围（刻意保守，不做全量客户价格表强制同步）：
 *   1. 当前 pricelistId 为空、CSV 有映射 → 回填（不覆盖任何已有值，零风险）
 *   2. 当前 pricelistId 指向"本次新建的价格表"名单之外的表，但 Odoo 说该客户应该用
 *      "本次新建的 9 张价格表"之一 → 修正（仅限这个精确范围，因为这批新客户目前普遍
 *      挂在错误的默认表下，其余客户的历史 pricelistId 不在本次改动范围内）
 *
 * 匹配规则：
 *   - CSV "id"                        = __export__.res_partner_<num>_<hash> → Customer.externalId（纯数字）
 *   - CSV "property_product_pricelist/id" → OdooPricelist.externalId → 本地 pricelist id
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

// 2026-07-15 本次从 Odoo 新建的价格表（只在这个精确范围内允许"修正"已有 pricelistId）
const NEWLY_CREATED_EXTERNAL_IDS = new Set([
  'product.list0',
  '__export__.product_pricelist_161_ba1939c1',
  '__export__.product_pricelist_160_41977d06',
  '__export__.product_pricelist_159_387b3ed6',
  '__export__.product_pricelist_165_e190757a',
  '__export__.product_pricelist_164_3e995869',
  '__export__.product_pricelist_163_bf3716b7',
  '__export__.product_pricelist_166_701972d1',
  '__export__.product_pricelist_162_9d3b1743',
])

function splitCsv(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}

async function main() {
  const pls = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true } })
  const plByExt = new Map<string, string>()
  for (const p of pls) if (p.externalId) plByExt.set(p.externalId, p.id)
  const newPlLocalIds = new Set([...NEWLY_CREATED_EXTERNAL_IDS].map(e => plByExt.get(e)).filter(Boolean) as string[])

  const raw = fs.readFileSync(path.join(process.cwd(), 'pic/res.partner.csv'), 'utf-8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  const headers = splitCsv(lines[0])
  const idx = (n: string) => headers.indexOf(n)
  const iId = idx('id'), iName = idx('name'), iPl = idx('property_product_pricelist/id')

  // customer externalId(num) → { pricelistLocalId, name }
  const csvMap = new Map<string, { plId: string; name: string }>()
  let csvRows = 0, csvWithPl = 0, csvUnmappable = 0
  for (const line of lines.slice(1)) {
    const cols = splitCsv(line)
    const extId = cols[iId]?.trim() ?? ''
    const plExt = cols[iPl]?.trim() ?? ''
    const name = cols[iName]?.trim() ?? ''
    const m = extId.match(/res_partner_(\d+)/)
    if (!m) continue
    csvRows++
    if (!plExt) continue
    csvWithPl++
    const localPl = plByExt.get(plExt)
    if (!localPl) { csvUnmappable++; continue }
    csvMap.set(m[1], { plId: localPl, name })
  }

  const allCusts = await prisma.customer.findMany({
    where: { NOT: { externalId: null } },
    select: { id: true, name: true, externalId: true, pricelists: { orderBy: { sequence: 'asc' }, select: { pricelistId: true } } },
  })

  const fillNull: { id: string; name: string; pricelistId: string }[] = []
  const fixNewPl: { id: string; name: string; from: string | null; pricelistId: string }[] = []
  for (const c of allCusts) {
    const mapped = c.externalId ? csvMap.get(c.externalId) : undefined
    if (!mapped) continue
    const currentTopPl = c.pricelists[0]?.pricelistId ?? null
    if (currentTopPl === null) {
      fillNull.push({ id: c.id, name: c.name, pricelistId: mapped.plId })
    } else if (currentTopPl !== mapped.plId && newPlLocalIds.has(mapped.plId)) {
      fixNewPl.push({ id: c.id, name: c.name, from: currentTopPl, pricelistId: mapped.plId })
    }
  }

  console.log('── CSV 解析 ──')
  console.log(`  CSV 客户行: ${csvRows} | 含 Pricelist: ${csvWithPl} | 无法映射(默认表/未知): ${csvUnmappable} | 可映射: ${csvMap.size}`)
  console.log('── 回填目标 ──')
  console.log(`  pricelistId 为空 → 回填: ${fillNull.length}`)
  console.log(`  当前挂错表、应改到本次新建价格表 → 修正: ${fixNewPl.length}`)
  for (const u of fixNewPl) console.log(`    ${u.name}: ${u.from} → ${u.pricelistId}`)

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入。加 --apply 实际执行。')
    return
  }

  const toApply = [...fillNull, ...fixNewPl.map(u => ({ id: u.id, name: u.name, pricelistId: u.pricelistId }))]
  console.log(`\n[APPLY] 开始回填/修正 ${toApply.length} 个客户的优先级第一价格表…`)
  const BATCH = 8 // 2026-07-15 首次 --apply 以 BATCH=50 触发 Neon P2028（事务池耗尽），调小并发以稳定通过
  let done = 0
  for (let i = 0; i < toApply.length; i += BATCH) {
    const batch = toApply.slice(i, i + BATCH)
    await Promise.all(batch.map(u =>
      // fillNull: 客户此前没有任何 CustomerPricelist 记录 → 直接建 sequence=1
      // fixNewPl: 客户已有 sequence=1 记录但指向错误的表 → 先删再建，保持 sequence=1 不变
      // 同时删掉客户名下"目标 pricelistId 已存在于其他 sequence"的旧记录，避免撞
      // @@unique([customerId, pricelistId]) —— 否则脚本在已有多价格表数据的库上重跑会报 P2002。
      prisma.$transaction([
        prisma.customerPricelist.deleteMany({
          where: { customerId: u.id, OR: [{ sequence: 1 }, { pricelistId: u.pricelistId }] },
        }),
        prisma.customerPricelist.create({ data: { customerId: u.id, pricelistId: u.pricelistId, sequence: 1 } }),
      ]),
    ))
    done += batch.length
    if (done % 200 === 0 || done === toApply.length) console.log(`  …${done}/${toApply.length}`)
  }
  console.log(`✅ 完成：处理 ${done} 个客户的优先级第一价格表`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
