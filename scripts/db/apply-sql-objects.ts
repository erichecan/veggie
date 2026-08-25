/**
 * 补齐 db push 跳过的「非表对象」（视图 / 扩展 / trgm 索引）
 * ============================================================================
 * 台账 D8 发现（Z6 的延伸）：`prisma db push` 只同步 schema.prisma 里描述得了的
 * 东西 —— 表、列、索引。**视图、扩展、函数索引都写在迁移 SQL 里**，db push 一律
 * 跳过。而全新库只能走 db push（迁移链无基线，见 scripts/db/bootstrap-fresh.ts）。
 *
 * 后果不是"少了点优化"：
 *   · `v_lot_daily_cost` 缺失 → /api/analytics/sales-overview 直接 500
 *     （computeDayMetrics 的成本 LATERAL JOIN 查这张视图），首页与销售统计整块打不开
 *   · `veggie_sales_report` 缺失 → 依赖它的报表查询同样报 relation does not exist
 *   · pg_trgm 索引缺失 → 分面搜索退化成全表扫描（能用，但生产库实测慢 10~4800 倍）
 *
 * 这三件事对**私有化部署从零起步**是致命的 —— 那正是本项目的目标架构。
 *
 * 这里列出的 4 个迁移文件都是幂等写法（CREATE OR REPLACE VIEW / IF NOT EXISTS），
 * 重复执行安全。新增视图迁移时**必须把文件名加进下面这张表**，否则新库又会缺。
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { createPrismaClient } from '../../lib/prisma-factory'

/** 按迁移时间顺序；同名视图后者覆盖前者（veggie_sales_report 有两版） */
const SQL_OBJECT_MIGRATIONS = [
  '20260522_reporting_views',
  '20260702000001_reporting_view_sales_user',
  '20260703000001_v_lot_daily_cost',
  '20260802070000_pg_trgm_facet_indexes',
  '20260825000005_reporting_views_drop_product_template',
]

/**
 * 语句里创建的对象名（视图/索引/扩展），用来判断"后面有没有人重新定义过它"。
 * 返回 null 表示这条语句不是对象定义（例如单纯的 SET）。
 */
export function objectKeyOf(stmt: string): string | null {
  const view = /CREATE\s+(?:OR\s+REPLACE\s+)?VIEW\s+([\w."]+)/i.exec(stmt)
  if (view) return `view:${view[1].toLowerCase()}`
  const index = /CREATE\s+INDEX(?:\s+CONCURRENTLY)?(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w."]+)/i.exec(stmt)
  if (index) return `index:${index[1].toLowerCase()}`
  const ext = /CREATE\s+EXTENSION(?:\s+IF\s+NOT\s+EXISTS)?\s+([\w."]+)/i.exec(stmt)
  if (ext) return `extension:${ext[1].toLowerCase()}`
  return null
}

/**
 * 把一个迁移文件切成可逐条执行的语句。
 * Prisma 的 $executeRawUnsafe 走扩展协议，一次只接受一条语句，所以必须切。
 * 这几个文件里没有函数体/DO 块（那种情况 `;` 不能当分隔符），加断言防止将来
 * 有人往列表里塞了带 $$ 的迁移却不改这里。
 */
export function splitSqlStatements(sql: string): string[] {
  if (sql.includes('$$')) {
    throw new Error('该迁移含 $$ 块（函数/DO），不能按分号切分；请单独处理')
  }
  return sql
    .split('\n')
    .filter((line) => !line.trim().startsWith('--'))
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean)
}

async function main() {
  const url = process.env.DATABASE_URL ?? ''
  if (!url) {
    console.error('DATABASE_URL 未设置。用 --env-file 指定环境文件。')
    process.exit(1)
  }
  // 与 bootstrap-fresh 同一道闸门：CREATE OR REPLACE VIEW 打到生产库上会即时改变
  // 线上报表的定义，不是可以顺手跑的东西
  if (!/localhost|127\.0\.0\.1/.test(url)) {
    console.error('⛔ 目标库不是本机地址。本脚本会重建视图，只允许打向本地库。')
    process.exit(1)
  }

  // ⚠️ 只执行每个对象的**最新**定义，不是把历史链重放一遍。
  // 20260522 那版 veggie_sales_report 里还有 `o.salesman` —— 那一列早已被
  // 20260702 的迁移删掉（改成 salesUserId 关联），重放旧版直接报 column does not exist。
  // 「重建 = 重放全部历史」在这里是错的：要的是终态，不是历史。
  const plan: Array<{ dir: string; stmt: string }> = []
  const latestIndex = new Map<string, number>()
  for (const dir of SQL_OBJECT_MIGRATIONS) {
    const file = join(process.cwd(), 'prisma', 'migrations', dir, 'migration.sql')
    for (const stmt of splitSqlStatements(readFileSync(file, 'utf8'))) {
      const key = objectKeyOf(stmt)
      if (key) latestIndex.set(key, plan.length)
      plan.push({ dir, stmt })
    }
  }
  const keep = new Set(latestIndex.values())
  const skipped: string[] = []

  const prisma = createPrismaClient()
  let applied = 0
  for (const [i, item] of plan.entries()) {
    const key = objectKeyOf(item.stmt)
    if (key && !keep.has(i)) {
      skipped.push(`${key}（被后续迁移重新定义，跳过 ${item.dir} 的旧版）`)
      continue
    }
    await prisma.$executeRawUnsafe(item.stmt)
    applied++
  }
  for (const s of skipped) console.log(`  ↷ ${s}`)

  // 建完立刻自检：这三个对象是应用真正会去查的，缺任何一个都会 500
  // to_regclass 返回 regclass，Prisma 反序列化不了 → 强转 text
  const checks = await prisma.$queryRawUnsafe(
    `SELECT to_regclass('v_lot_daily_cost')::text AS lot_cost,
            to_regclass('veggie_sales_report')::text AS sales_report,
            to_regclass('veggie_logistics_report')::text AS logistics_report`,
  ) as Array<Record<string, string | null>>
  const missing = Object.entries(checks[0] ?? {}).filter(([, v]) => v === null).map(([k]) => k)
  await prisma.$disconnect()

  if (missing.length > 0) {
    console.error(`⛔ 执行完仍缺少：${missing.join(', ')}`)
    process.exit(1)
  }
  console.log(`✅ ${applied} 条语句执行完毕，视图自检通过`)
}

main().catch((e) => { console.error(e); process.exit(1) })
