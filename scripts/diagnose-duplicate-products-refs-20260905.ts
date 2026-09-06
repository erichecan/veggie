/**
 * 只读诊断续：重名商品分组里，除已查过的 orderLines/stockMoves/lots/aliases/
 * supplierInfo/saleUoms/customerSpecialPrice 外，再摸一遍采购侧表 + OdooPricelist.items JSON
 * 是否也引用了这些重复 id，避免遗漏引用面。
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-duplicate-products-refs-20260905.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

async function main() {
  const products = await prisma.product.findMany({
    select: { id: true, name: true },
  })
  const groups = new Map<string, string[]>()
  for (const p of products) {
    const key = p.name.trim()
    const list = groups.get(key) ?? []
    list.push(p.id)
    groups.set(key, list)
  }
  const dupIds = [...groups.values()].filter((list) => list.length > 1).flat()
  console.log(`重复分组涉及 productId 总数: ${dupIds.length}`)

  const [poLine, purchaseRecord, purchaseSuggestion, creditNoteLine, stockTakeLine, orderDiscrepancy] =
    await Promise.all([
      prisma.purchaseOrderLine.count({ where: { productId: { in: dupIds } } }),
      prisma.purchaseRecord.count({ where: { productId: { in: dupIds } } }),
      prisma.purchaseSuggestion.count({ where: { productId: { in: dupIds } } }),
      prisma.creditNoteLine.count({ where: { productId: { in: dupIds } } }),
      prisma.stockTakeLine.count({ where: { productId: { in: dupIds } } }),
      prisma.orderDiscrepancy.count({ where: { productId: { in: dupIds } } }),
    ])
  console.log({ poLine, purchaseRecord, purchaseSuggestion, creditNoteLine, stockTakeLine, orderDiscrepancy })

  const pricelists = await prisma.odooPricelist.findMany({ select: { id: true, name: true, items: true } })
  let pricelistHits = 0
  const dupIdSet = new Set(dupIds)
  for (const pl of pricelists) {
    const items = Array.isArray(pl.items) ? (pl.items as any[]) : []
    for (const it of items) {
      const pid = it?.productId ?? it?.productTemplateId
      if (pid && dupIdSet.has(pid)) {
        pricelistHits++
        console.log(`  pricelist=${pl.name} item指向重复商品 id=${pid}`)
      }
    }
  }
  console.log(`OdooPricelist.items 命中重复商品的条目数: ${pricelistHits}`)

  const custPricelists = await prisma.customerPricelist.count()
  console.log(`CustomerPricelist 总数(结构上没有productId,略过): ${custPricelists}`)
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
