/**
 * 订正脚本：创建 4 个仓库温区（冷冻/冷藏/常温干货/常温超市），把现有
 * ProductCategory.requiredZoneId 批量指过去。
 *
 * 背景：库存模块升级需要"仓库地图·温区库存"页展示真实数据、并检测放错温区的商品，
 * 但现有 ProductCategory 没有温区归属，仓库地图此前是纯装饰 SVG（4 个硬编码分区，
 * 无任何数据支撑，见 docs/20260624-data-ownership-audit.md）。
 *
 * requiredZoneId 判定粒度是 ProductCategory（比 CategoryGroup 细），因为
 * FRESH_FROZEN 一个大类里同时有真冷冻(肉类/海鲜/冷冻半成品)和冷藏(蔬菜/水果/豆制品)。
 * 判定规则（按类目 name/nameZh 关键词，命中优先级从上到下）：
 *   1. 名称含 frozen/冷冻/肉类/海鲜/meat/seafood/面点/饺子 → FROZEN
 *   2. 属于 DRY_GOODS 分组 → DRY
 *   3. 属于 SUPERMARKET 或 JAPANESE_KOREAN 分组 → AMBIENT（常温杂货为主，个别单品可在
 *      Product.currentZoneId 单独标记为冷冻，与类目默认值不一致即触发"温区不符"提示）
 *   4. 属于 FRESH_FROZEN 分组的其余类目（菜/果/蛋/豆制品/香草） → CHILLED
 *   5. 未分组类目 → 不写 requiredZoneId，保持 null（人工判断）
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-zones.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-zones.ts dotenv_config_path=.env.local --apply    # 写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

const ZONES = [
  { key: 'FROZEN', name: 'Frozen', nameZh: '冷冻区', tempRangeLabel: '-18°C 以下' },
  { key: 'CHILLED', name: 'Chilled', nameZh: '冷藏区', tempRangeLabel: '0°C ~ 4°C' },
  { key: 'DRY', name: 'Dry Goods', nameZh: '常温干货区', tempRangeLabel: '常温 · 避光干燥' },
  { key: 'AMBIENT', name: 'Ambient', nameZh: '常温超市区', tempRangeLabel: '常温' },
] as const

const FROZEN_MATCH = /frozen|冷冻|肉类|海鲜|meat|seafood|面点|饺子|dim ?sum|pastry/i

function classify(
  name: string,
  nameZh: string | null,
  groupKey: string | null,
): (typeof ZONES)[number]['key'] | null {
  const hay = `${name} ${nameZh ?? ''}`.trim()
  if (FROZEN_MATCH.test(hay)) return 'FROZEN'
  if (groupKey === 'DRY_GOODS') return 'DRY'
  if (groupKey === 'SUPERMARKET' || groupKey === 'JAPANESE_KOREAN') return 'AMBIENT'
  if (groupKey === 'FRESH_FROZEN') return 'CHILLED'
  return null
}

async function main() {
  console.log(`\n=== 仓库温区回填 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const zoneIdByKey = new Map<string, string>()
  for (const z of ZONES) {
    const existing = await prisma.zone.findUnique({ where: { key: z.key } })
    if (existing) {
      zoneIdByKey.set(z.key, existing.id)
      console.log(`  温区已存在，复用：${z.nameZh} → ${existing.id}`)
      continue
    }
    console.log(`  ${APPLY ? '创建' : '[将创建]'} 温区：${z.nameZh}（${z.key}）`)
    if (APPLY) {
      const created = await prisma.zone.create({ data: z })
      zoneIdByKey.set(z.key, created.id)
    }
  }
  console.log('')

  const cats = await prisma.productCategory.findMany({
    select: { id: true, name: true, nameZh: true, groupId: true, group: { select: { key: true } } },
  })
  const byZone = new Map<string, typeof cats>()
  const unmatched: typeof cats = []
  for (const c of cats) {
    const z = classify(c.name, c.nameZh, c.group?.key ?? null)
    if (!z) { unmatched.push(c); continue }
    if (!byZone.has(z)) byZone.set(z, [])
    byZone.get(z)!.push(c)
  }

  console.log('【分类统计】')
  for (const z of ZONES) {
    const rows = byZone.get(z.key) ?? []
    console.log(`  ${z.nameZh.padEnd(8, '　')} : ${rows.length} 个类目 — ${rows.map(r => r.name).join(', ')}`)
  }
  console.log(`  未匹配（保持未映射） : ${unmatched.length} 个类目 — ${unmatched.map(r => r.name).join(', ')}`)
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行订正。===\n')
    return
  }

  let updated = 0
  for (const [key, rows] of byZone.entries()) {
    const zoneId = zoneIdByKey.get(key)
    if (!zoneId || rows.length === 0) continue
    const ids = rows.map(r => r.id)
    const res = await prisma.$executeRaw`UPDATE "ProductCategory" SET "requiredZoneId" = ${zoneId} WHERE id = ANY(${ids})`
    updated += res
    console.log(`  ${key.padEnd(16)} → requiredZoneId=${zoneId}  已更新 ${res} 行`)
  }
  console.log(`\n✅ 订正完成：ProductCategory.requiredZoneId 写入 ${updated} 行。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
