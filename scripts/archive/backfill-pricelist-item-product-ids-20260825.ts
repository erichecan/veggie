/**
 * 合表重构 T4：OdooPricelistItem.productTemplateId 松引用 remap
 *
 * 背景：`OdooPricelist.items` 是 JSON 数组，字段没有数据库级 FK 约束。
 * `applyOn:'product'` 的条目里 `productTemplateId` 指向 `ProductTemplate.id`；
 * `applyOn:'variant'` 的条目 `productVariantId` 已经指向 `Product.id`，不用管。
 * T5 要删掉 ProductTemplate 表，删表前必须把 `applyOn:'product'` 条目的
 * `productTemplateId` 换成对应 `Product.id`，否则这批定价规则会失效或指向不存在的 id。
 *
 * 字段名本身不改（还叫 productTemplateId），值换成 Product.id —— 是否要把
 * applyOn:'product'/'variant' 合并成一层选择器是 T8 前端改造的范围，这里只
 * 保证数据在删表后不断链。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-pricelist-item-product-ids-20260825.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-pricelist-item-product-ids-20260825.ts dotenv_config_path=.env.local --apply    # 写库
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()
const APPLY = process.argv.includes('--apply')

interface Item {
  id?: string
  applyOn?: string
  productTemplateId?: string
  productVariantId?: string
  [k: string]: unknown
}

async function main() {
  console.log(`\n=== OdooPricelistItem.productTemplateId remap (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const templateToProduct = new Map<string, string>()
  for (const p of await prisma.product.findMany({ select: { id: true, templateId: true } })) {
    templateToProduct.set(p.templateId, p.id)
  }
  console.log(`  模板→商品映射：${templateToProduct.size} 条\n`)

  const pricelists = await prisma.odooPricelist.findMany({ select: { id: true, name: true, items: true } })

  let totalProduct = 0, totalVariant = 0, totalGlobalOrCategory = 0, remapped = 0, orphaned = 0, listsTouched = 0
  const orphanSamples: Array<{ pricelistId: string; itemId?: string; productTemplateId?: string }> = []

  for (const pl of pricelists) {
    const items = (pl.items as unknown as Item[]) ?? []
    let changed = false
    const nextItems = items.map(item => {
      if (item.applyOn === 'variant') { totalVariant++; return item }
      if (item.applyOn !== 'product') { totalGlobalOrCategory++; return item }
      totalProduct++
      const productId = item.productTemplateId ? templateToProduct.get(item.productTemplateId) : undefined
      if (!productId) {
        orphaned++
        if (orphanSamples.length < 10) orphanSamples.push({ pricelistId: pl.id, itemId: item.id, productTemplateId: item.productTemplateId })
        return item
      }
      remapped++
      changed = true
      return { ...item, productTemplateId: productId }
    })
    if (changed) {
      listsTouched++
      if (APPLY) {
        await prisma.odooPricelist.update({ where: { id: pl.id }, data: { items: nextItems as never } })
      }
    }
  }

  console.log(`  applyOn='product'  条目：${totalProduct}`)
  console.log(`  applyOn='variant'  条目：${totalVariant}（已指向 Product.id，无需处理）`)
  console.log(`  applyOn='global'/'category' 条目：${totalGlobalOrCategory}`)
  console.log(`  ${APPLY ? '已' : '将'} remap：${remapped} 条，涉及 ${listsTouched} 个价格表`)
  console.log(`  找不到对应 Product（孤儿引用，未处理）：${orphaned} 条`)
  if (orphanSamples.length > 0) {
    console.log('\n  孤儿引用样例：')
    for (const s of orphanSamples) console.log(`    pricelist=${s.pricelistId} item=${s.itemId} productTemplateId=${s.productTemplateId}`)
  }
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行 remap。===\n')
  } else {
    console.log('✅ remap 完成。\n')
  }
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
