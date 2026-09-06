/**
 * 只读诊断：找出同名 Product 重复分组，摸清合并/去重的影响面。
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-duplicate-products-20260905.ts
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()

async function main() {
  const products = await prisma.product.findMany({
    select: {
      id: true, name: true, type: true, status: true, active: true,
      qtyOnHand: true, createdAt: true, externalId: true, categoryId: true,
      canBeSold: true, canBePurchased: true,
    },
    orderBy: [{ name: 'asc' }, { createdAt: 'asc' }],
  })

  const groups = new Map<string, typeof products>()
  for (const p of products) {
    const key = p.name.trim()
    const list = groups.get(key) ?? []
    list.push(p)
    groups.set(key, list)
  }

  const dupGroups = [...groups.entries()].filter(([, list]) => list.length > 1)
  console.log(`总商品数: ${products.length}`)
  console.log(`重名分组数: ${dupGroups.length}`)

  const typeMismatch = dupGroups.filter(([, list]) => new Set(list.map((p) => p.type)).size > 1)
  console.log(`其中 type 不一致的分组: ${typeMismatch.length}`)

  const ids = dupGroups.flatMap(([, list]) => list.map((p) => p.id))

  const [lineCounts, stockMoveCounts, lotCounts, aliasCounts, supplierInfoCounts, saleUomCounts, csPriceCounts] =
    await Promise.all([
      prisma.orderLine.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.stockMove.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.lot.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.productAlias.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.productSupplierInfo.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.productSaleUom.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
      prisma.customerSpecialPrice.groupBy({ by: ['productId'], where: { productId: { in: ids } }, _count: true }),
    ])

  const toMap = (rows: { productId: string; _count: number | { productId?: number } }[]) => {
    const m = new Map<string, number>()
    for (const r of rows) m.set(r.productId, typeof r._count === 'number' ? r._count : (r._count.productId ?? 0))
    return m
  }
  const lineM = toMap(lineCounts as any)
  const moveM = toMap(stockMoveCounts as any)
  const lotM = toMap(lotCounts as any)
  const aliasM = toMap(aliasCounts as any)
  const supM = toMap(supplierInfoCounts as any)
  const uomM = toMap(saleUomCounts as any)
  const cspM = toMap(csPriceCounts as any)

  console.log('\n=== 详细分组（前 60 组全部打印） ===')
  for (const [name, list] of dupGroups) {
    const mismatch = new Set(list.map((p) => p.type)).size > 1
    console.log(`\n· ${name}${mismatch ? '  ⚠️ type不一致' : ''}`)
    for (const p of list) {
      console.log(
        `  - id=${p.id} type=${p.type} status=${p.status} active=${p.active} externalId=${p.externalId ?? '-'} ` +
          `qtyOnHand=${p.qtyOnHand} category=${p.categoryId ?? '-'} createdAt=${p.createdAt.toISOString().slice(0, 10)} ` +
          `orderLines=${lineM.get(p.id) ?? 0} stockMoves=${moveM.get(p.id) ?? 0} lots=${lotM.get(p.id) ?? 0} ` +
          `aliases=${aliasM.get(p.id) ?? 0} supplierInfo=${supM.get(p.id) ?? 0} saleUoms=${uomM.get(p.id) ?? 0} customerSpecialPrice=${cspM.get(p.id) ?? 0}`
      )
    }
  }

  const createdDates = new Map<string, number>()
  for (const p of products) {
    const d = p.createdAt.toISOString().slice(0, 10)
    createdDates.set(d, (createdDates.get(d) ?? 0) + 1)
  }
  console.log('\n=== 商品 createdAt 按日分布（前 20 个最多的日期） ===')
  for (const [d, c] of [...createdDates.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20)) {
    console.log(`  ${d}: ${c}`)
  }
}

main()
  .catch((e) => {
    console.error(e)
    process.exit(1)
  })
  .finally(() => prisma.$disconnect())
