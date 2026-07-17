/**
 * scripts/import-odoo-categories-20260717.ts
 *
 * 全量数据迁移 Phase 3a：从本地 Odoo 镜像库（scripts/odoo-migration/pgdata，见
 * docs/20260716 系列讨论）导出的 product_category（31 条）同步 ProductCategory。
 *
 * 匹配规则：
 *   - Odoo product_category.id（数字）→ ProductCategory.externalId（已于 Phase 2 加 @unique）
 *   - 匹配到 → 原地覆盖 name
 *   - Odoo 有、本地没有 → 新建（groupId/requiredZoneId 留空，需要运营后续手工分类）
 *   - 不做归档：生产库现有 57 条里有 26 条是本系统自建的运营分类（非 Odoo 来源），
 *     这次只管 Odoo 来源的 31 条，不动其余
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-categories-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-categories-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
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
const CSV_PATH = path.join(__dirname, 'odoo-migration/exports/product_category.csv')
const BACKUP_PATH = path.join(__dirname, '.backup-categories-pre-20260717.json')

function parseCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}
function parseCsv(raw: string): Record<string, string>[] {
  const physicalLines = raw.split('\n')
  const rows: string[][] = []
  let buf = ''
  for (const pl of physicalLines) {
    buf = buf ? buf + '\n' + pl : pl
    const quoteCount = (buf.match(/"/g) ?? []).length
    if (quoteCount % 2 === 0) {
      if (buf.trim().length > 0) rows.push(parseCSVLine(buf))
      buf = ''
    }
  }
  const headers = rows[0]
  return rows.slice(1).map(vals => {
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'))
  console.log(`CSV 解析：${rows.length} 条类目`)

  const existing = await prisma.productCategory.findMany({ select: { id: true, name: true, externalId: true } })
  const byExt = new Map(existing.filter(c => c.externalId).map(c => [c.externalId as string, c]))

  const toUpdate = rows.filter(r => byExt.has(r.external_id))
  const toCreate = rows.filter(r => !byExt.has(r.external_id))

  console.log(`计划：更新 ${toUpdate.length} / 新建 ${toCreate.length}`)
  for (const r of toCreate) console.log(`  [新建] ${r.external_id} ${r.name}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(existing, null, 2))
  console.log(`已备份当前 ${existing.length} 条类目到 ${BACKUP_PATH}`)

  let updated = 0, created = 0
  for (const r of toUpdate) {
    const cur = byExt.get(r.external_id)!
    if (cur.name !== r.name) {
      await prisma.productCategory.update({ where: { id: cur.id }, data: { name: r.name } })
      updated++
    }
  }
  for (const r of toCreate) {
    await prisma.productCategory.create({ data: { name: r.name, externalId: r.external_id } })
    created++
  }
  console.log(`✅ 完成：更新 ${updated} / 新建 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
