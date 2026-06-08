/**
 * scripts/drop-dangling-pricelist-items.ts
 *
 * 去重后清理：删除所有 productVariantId / productTemplateId 指向"已不存在商品/模板"的
 * 价格表条目（去重删旧代次后产生的悬空引用）。保留全部有效条目。
 *
 *   node --import tsx -r dotenv/config scripts/drop-dangling-pricelist-items.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/drop-dangling-pricelist-items.ts dotenv_config_path=.env.local --apply
 */
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })
const APPLY = process.argv.includes('--apply')

async function main() {
  const liveProd = new Set((await prisma.product.findMany({ select: { id: true } })).map(p => p.id))
  const liveTmpl = new Set((await prisma.productTemplate.findMany({ select: { id: true } })).map(t => t.id))

  const pls = await prisma.odooPricelist.findMany({ select: { id: true, name: true, items: true } })
  let totalBefore = 0, totalDropped = 0, plChanged = 0
  const updates: { id: string; items: any[] }[] = []

  for (const pl of pls) {
    const items = (pl.items as any[]) ?? []
    totalBefore += items.length
    const kept = items.filter(it => {
      // 只按 applyOn 检查相关字段；variant 规则只看 productVariantId（忽略残留的 templateId）
      if (it.applyOn === 'variant') return !it.productVariantId || liveProd.has(it.productVariantId)
      if (it.applyOn === 'product') return !it.productTemplateId || liveTmpl.has(it.productTemplateId)
      return true
    })
    if (kept.length !== items.length) {
      plChanged++
      totalDropped += items.length - kept.length
      updates.push({ id: pl.id, items: kept })
    }
  }

  console.log(`价格表条目总数: ${totalBefore}`)
  console.log(`悬空待删: ${totalDropped}（涉及 ${plChanged} 张价格表）`)

  if (!APPLY) { console.log('\n[DRY-RUN] 未改动。加 --apply 执行。'); return }

  for (const u of updates) {
    await prisma.odooPricelist.update({ where: { id: u.id }, data: { items: u.items as never } })
  }
  console.log(`✅ 完成：清理 ${plChanged} 张价格表，删除 ${totalDropped} 条悬空条目`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
