/**
 * 订正脚本：创建四大采购品类分组，把现有 26+ 个细分商品类目映射进去
 *
 * 背景：采购模块升级需要按"干货 / 日韩商品 / 超市商品 / 蔬菜生鲜冷冻"四大类
 * 分别配置不同的补货节奏（每日自动 / 周期提醒 / 年度计划），但现有
 * ProductCategory 是从 Odoo 直接迁移过来的扁平细分类目（蔬菜/干货/罐头/面粉/
 * 韩国商品……），没有对应的上位分组。
 *
 * 本脚本：
 *   1. 幂等 upsert 4 条 CategoryGroup（按 key 唯一约束）
 *   2. 按类目名称/中文名关键词匹配规则，把 ProductCategory.groupId 批量指过去
 *   3. 无法判断归属的类目（All/Uncategorized/PoS/Saleable/Stockable/Sundry 等
 *      非业务性/模糊类目）保持 groupId=null，不强行归类
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-category-groups.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-category-groups.ts dotenv_config_path=.env.local --apply    # 写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

const GROUPS = [
  { key: 'DRY_GOODS', name: 'Dry Goods', nameZh: '干货', cadence: 'ANNUAL' },
  { key: 'JAPANESE_KOREAN', name: 'Japanese & Korean', nameZh: '日韩商品', cadence: 'PERIODIC' },
  { key: 'SUPERMARKET', name: 'Supermarket', nameZh: '超市商品', cadence: 'PERIODIC' },
  { key: 'FRESH_FROZEN', name: 'Fresh & Frozen', nameZh: '蔬菜生鲜冷冻', cadence: 'DAILY' },
] as const

// 按类目 name（英文原名，Odoo 迁移字段，比 nameZh 更完整覆盖）关键词匹配
const RULES: Array<{ group: (typeof GROUPS)[number]['key']; match: RegExp }> = [
  // 蔬菜生鲜冷冻
  { group: 'FRESH_FROZEN', match: /veg|fruit|frozen|meat|seafood|egg|herb|tofu|dim ?sum|pastry/i },
  // 日韩商品
  { group: 'JAPANESE_KOREAN', match: /asian grocery|korean|^jp|kitchen supplies|^kr$/i },
  // 干货（米面粮油、耐存调味品、罐头、面条）
  { group: 'DRY_GOODS', match: /canned|preserved|rice|noodle|dry food|spice|sauce|paste|pickle|mooncake/i },
  // 超市商品（饮料、零食、清洁、包装、日用杂货）
  { group: 'SUPERMARKET', match: /drink|snack|cleaning|packaging|miscellaneous/i },
]

function classify(name: string, nameZh: string | null): (typeof GROUPS)[number]['key'] | null {
  const hay = `${name} ${nameZh ?? ''}`.trim()
  for (const r of RULES) {
    if (r.match.test(hay)) return r.group
  }
  return null
}

async function main() {
  console.log(`\n=== 采购品类分组回填 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const groupIdByKey = new Map<string, string>()
  for (const g of GROUPS) {
    const existing = await prisma.categoryGroup.findUnique({ where: { key: g.key } })
    if (existing) {
      groupIdByKey.set(g.key, existing.id)
      console.log(`  分组已存在，复用：${g.nameZh} → ${existing.id}`)
      continue
    }
    console.log(`  ${APPLY ? '创建' : '[将创建]'} 分组：${g.nameZh}（${g.key}，节奏=${g.cadence}）`)
    if (APPLY) {
      const created = await prisma.categoryGroup.create({ data: g })
      groupIdByKey.set(g.key, created.id)
    }
  }
  console.log('')

  const cats = await prisma.productCategory.findMany({ select: { id: true, name: true, nameZh: true, groupId: true } })
  const byGroup = new Map<string, typeof cats>()
  const unmatched: typeof cats = []
  for (const c of cats) {
    const g = classify(c.name, c.nameZh)
    if (!g) { unmatched.push(c); continue }
    if (!byGroup.has(g)) byGroup.set(g, [])
    byGroup.get(g)!.push(c)
  }

  console.log('【分类统计】')
  for (const g of GROUPS) {
    const rows = byGroup.get(g.key) ?? []
    console.log(`  ${g.nameZh.padEnd(8, '　')} : ${rows.length} 个类目 — ${rows.map(r => r.name).join(', ')}`)
  }
  console.log(`  未匹配（保持未分组） : ${unmatched.length} 个类目 — ${unmatched.map(r => r.name).join(', ')}`)
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行订正。===\n')
    return
  }

  let updated = 0
  for (const [key, rows] of byGroup.entries()) {
    const groupId = groupIdByKey.get(key)
    if (!groupId || rows.length === 0) continue
    const ids = rows.map(r => r.id)
    const res = await prisma.$executeRaw`UPDATE "ProductCategory" SET "groupId" = ${groupId} WHERE id = ANY(${ids})`
    updated += res
    console.log(`  ${key.padEnd(16)} → groupId=${groupId}  已更新 ${res} 行`)
  }
  console.log(`\n✅ 订正完成：ProductCategory.groupId 写入 ${updated} 行。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
