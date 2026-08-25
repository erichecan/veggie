/**
 * 合表重构 T3：把 ProductTemplate 的字段回填进 Product（T1 新加的 20 个字段 + 少量兜底修复）
 *
 * 依据 T2 的 diff 报表（scripts/diff-product-template-fields-20260825.ts）：
 *   - 20 个新字段（type/canBeSold/canBePurchased/description/saleDescription/weight/
 *     netWeight/volume/isPackaging/canBeExpensed/uomId/purchaseUomId/unitOfMeasure/
 *     purchaseUoM/tracking/websitePublished/websiteName/vendorTaxRate/forecastQty/
 *     createdBy/updatedBy/barcode）：Product 侧目前全是默认值，直接从 Template 覆盖。
 *   - internalRef / categoryId / images / customerTaxRate：Product 优先，Product 为空
 *     （images 是"空数组"）才退回 Template ——这是现有 /api/products GET 的运行时
 *     兜底约定（`p.internalRef ?? template?.internalRef ?? null` 等），回填时复用
 *     同一条规则，保证迁移前后这几个字段的可见值不变。
 *   - name / listPrice / standardPrice / commissionPrice / status / sequence /
 *     externalId：Product 侧已是权威值（定价引擎 product-first、选品读 Product.name），
 *     本脚本不覆盖，即便与 Template 有历史分歧也保留 Product 侧现状。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-product-template-fields-20260825.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-product-template-fields-20260825.ts dotenv_config_path=.env.local --apply    # 写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

async function main() {
  console.log(`\n=== ProductTemplate → Product 字段回填 (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const [{ count: total }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count FROM "Product" p JOIN "ProductTemplate" t ON p."templateId" = t.id
  `
  console.log(`  Product 总行数（应与 ProductTemplate 1:1）：${total}`)

  const [{ count: internalRefFallback }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count FROM "Product" p JOIN "ProductTemplate" t ON p."templateId" = t.id
    WHERE p."internalRef" IS NULL AND t."internalRef" IS NOT NULL
  `
  const [{ count: categoryFallback }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count FROM "Product" p JOIN "ProductTemplate" t ON p."templateId" = t.id
    WHERE p."categoryId" IS NULL AND t."categoryId" IS NOT NULL
  `
  const [{ count: imagesFallback }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count FROM "Product" p JOIN "ProductTemplate" t ON p."templateId" = t.id
    WHERE cardinality(p."images") = 0 AND cardinality(t."images") > 0
  `
  const [{ count: taxFallback }] = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT COUNT(*)::int AS count FROM "Product" p JOIN "ProductTemplate" t ON p."templateId" = t.id
    WHERE p."customerTaxRate" IS NULL AND t."customerTaxRate" IS NOT NULL
  `
  console.log(`  internalRef 将回退取模板值：${internalRefFallback} 条`)
  console.log(`  categoryId  将回退取模板值：${categoryFallback} 条`)
  console.log(`  images      将回退取模板值：${imagesFallback} 条`)
  console.log(`  customerTaxRate 将回退取模板值：${taxFallback} 条`)
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行回填。===\n')
    return
  }

  const updated = await prisma.$executeRaw`
    UPDATE "Product" p SET
      "type"             = t."type",
      "canBeSold"        = t."canBeSold",
      "canBePurchased"   = t."canBePurchased",
      "description"      = t."description",
      "saleDescription"  = t."saleDescription",
      "weight"           = t."weight",
      "netWeight"        = t."netWeight",
      "volume"           = t."volume",
      "isPackaging"      = t."isPackaging",
      "canBeExpensed"    = t."canBeExpensed",
      "uomId"            = t."uomId",
      "purchaseUomId"    = t."purchaseUomId",
      "unitOfMeasure"    = t."unitOfMeasure",
      "purchaseUoM"      = t."purchaseUoM",
      "tracking"         = t."tracking",
      "websitePublished" = t."websitePublished",
      "websiteName"      = t."websiteName",
      "vendorTaxRate"    = t."vendorTaxRate",
      "forecastQty"      = t."forecastQty",
      "createdBy"        = t."createdBy",
      "updatedBy"        = t."updatedBy",
      "barcode"          = t."barcode",
      "internalRef"      = COALESCE(p."internalRef", t."internalRef"),
      "categoryId"       = COALESCE(p."categoryId", t."categoryId"),
      "images"           = CASE WHEN cardinality(p."images") = 0 THEN t."images" ELSE p."images" END,
      "customerTaxRate"  = COALESCE(p."customerTaxRate", t."customerTaxRate")
    FROM "ProductTemplate" t
    WHERE p."templateId" = t.id
  `
  console.log(`✅ 回填完成：${updated} 行 Product 已更新。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
