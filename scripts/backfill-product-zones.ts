/**
 * 订正脚本：初始化 Product.currentZoneId = 商品所属类目的 requiredZoneId。
 *
 * 背景：温区模型是全新上线，仓库里的商品实际已经按类目习惯堆放，只是系统此前不记录
 * 位置。上线当天假设"现状即合规"（currentZoneId = requiredZoneId），之后的收货/移库/
 * 盘点操作才会让两者出现分歧，那才是真正需要仓库地图页提示的"放错温区"。
 * 不这样初始化的话，所有商品都会被系统误报为"未定位/温区不符"，第一天就是满屏红色。
 *
 * 只回填 currentZoneId 为空、且所属类目有 requiredZoneId 的商品。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-product-zones.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-product-zones.ts dotenv_config_path=.env.local --apply    # 写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n=== 商品温区初始化 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const products = await prisma.product.findMany({
    where: { currentZoneId: null, category: { requiredZoneId: { not: null } } },
    select: { id: true, categoryId: true, category: { select: { requiredZoneId: true, nameZh: true, name: true } } },
  })

  const byZone = new Map<string, string[]>()
  for (const p of products) {
    const zoneId = p.category!.requiredZoneId!
    if (!byZone.has(zoneId)) byZone.set(zoneId, [])
    byZone.get(zoneId)!.push(p.id)
  }

  const zones = await prisma.zone.findMany()
  const zoneLabel = new Map(zones.map(z => [z.id, z.nameZh]))

  console.log(`待初始化商品总数：${products.length}`)
  for (const [zoneId, ids] of byZone.entries()) {
    console.log(`  ${(zoneLabel.get(zoneId) ?? zoneId).padEnd(8, '　')} : ${ids.length} 个商品`)
  }
  console.log('')

  const stillNull = await prisma.product.count({ where: { currentZoneId: null } })
  const noCategoryZone = await prisma.product.count({
    where: { currentZoneId: null, OR: [{ categoryId: null }, { category: { requiredZoneId: null } }] },
  })
  console.log(`当前 currentZoneId 为空的商品：${stillNull}（其中 ${noCategoryZone} 个因类目未映射温区，本次不处理）`)
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行订正。===\n')
    return
  }

  let updated = 0
  for (const [zoneId, ids] of byZone.entries()) {
    const res = await prisma.$executeRaw`UPDATE "Product" SET "currentZoneId" = ${zoneId} WHERE id = ANY(${ids})`
    updated += res
    console.log(`  → zoneId=${zoneId}  已更新 ${res} 行`)
  }
  console.log(`\n✅ 订正完成：Product.currentZoneId 写入 ${updated} 行。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
