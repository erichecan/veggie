/**
 * 审计：有订单行、但商品当前没配基准单位（ProductTemplate.uomId IS NULL）的商品清单
 * ============================================================================
 * 背景：拣货单/送货单等打印模板按 `${productId}::${uomId}` 分组，uomId 为空时
 * `Product.uomName` 派生结果也是 null，前端兜底成通用占位字符串「Unit(s)」。
 * 同一商品若有的历史订单行是在配了基准单位之后下的（uomName 是真实单位名），
 * 有的是在那之前下的（uomName 是占位符），两行印在同一张单上会像是两种不同货，
 * 拣货员没法判断（DEV-PLAN 20260823 决策#1）。
 *
 * 本脚本只读，不写库——列出真正有风险的商品（有订单行 + uomId 为空），
 * 供运营去商品详情页补 Unit of Measure。`scripts/backfill-product-uom.ts` 是
 * 另一个脚本（按商品名后缀批量回填 LOOSE/BULK 分类），两者目的不同：
 * 那个是"批量猜"，这个是"精确列出需要人工确认的清单"。
 *
 * 用法：node --import tsx -r dotenv/config scripts/audit/products-missing-uom.ts dotenv_config_path=.env.local
 */
import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

async function main() {
  console.log('\n=== 有订单行但未配基准单位的商品 ===\n')

  const totalTemplates = await prisma.productTemplate.count()
  const nullUomTemplates = await prisma.productTemplate.count({ where: { uomId: null } })
  console.log(`商品模板总数 ${totalTemplates}，其中未配基准单位 ${nullUomTemplates}（多数是从未上过订单的历史/停用商品，不影响打印）\n`)

  const rows = await prisma.$queryRaw<Array<{ id: string; name: string; line_count: number }>>`
    SELECT pt.id, pt.name, COUNT(DISTINCT ol.id)::int AS line_count
    FROM "ProductTemplate" pt
    JOIN "Product" p ON p."templateId" = pt.id
    JOIN "OrderLine" ol ON ol."productId" = p.id
    WHERE pt."uomId" IS NULL
    GROUP BY pt.id, pt.name
    ORDER BY line_count DESC
  `

  console.log(`真正有风险的商品（有订单行 + 未配基准单位）：${rows.length} 个\n`)
  for (const r of rows) {
    console.log(`  [${String(r.line_count).padStart(3)} 行]  ${r.name}  (${r.id})`)
  }
  console.log('\n请到「Products」逐个补 Unit of Measure；补完后这些商品的订单行在打印单据上\n将显示真实单位名，不会再和同一商品的其他行混排出两种不一致的单位标签。\n')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
