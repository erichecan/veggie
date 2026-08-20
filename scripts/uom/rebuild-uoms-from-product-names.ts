/**
 * 用商品名里的单位后缀重建计量单位表（20260819）
 * ============================================================================
 * 客户原话：「与其自己编造，不如直接从商品名里全部提炼出来，
 * 这样更符合客户原来的商品管理规则」。
 *
 * 判据全在 `lib/uom/extract-from-product-name.ts`（纯函数，19 条单测），
 * 这个脚本只负责取数据、比对、落库。
 *
 * ## 会做什么
 *
 * 1. 扫描 ACTIVE 可售商品的名字，提炼末词单位（大小写归一 + 拼写修正）
 * 2. 提炼出来但库里没有的 → 新建 Uom
 * 3. 库里有但商品名里从来没出现、且**没有任何商品或订单行在用**的自造单位
 *    （箱/袋/头/盒/板/筐/把/扎…）→ 设为 inactive
 *
 * ## 不会做什么
 *
 * - ⛔ 不删任何 Uom。历史 OrderLine 存的是 `uomName` 文本快照没错，
 *   但 `uomId` 是外键，删了会变悬空，日后按单位统计直接对不上。停用足矣。
 * - ⛔ 不动商品名。名字里的后缀留在原处 —— 那是客户自己的命名习惯，
 *   而且送货单/发票上印的就是它。
 * - ⛔ 不给单位设 factor。20260819 起换算系数挂在 `ProductSaleUom.factor`
 *   （每个商品自己的箱规），全局单位只需要名字 —— 这正是「从商品名提炼」
 *   可行的前提：`CASE` 在不同商品上箱规不同，但作为名字它是同一个。
 *
 * 用法：
 *   npx tsx --env-file=.env.test scripts/uom/rebuild-uoms-from-product-names.ts
 *   npx tsx --env-file=.env.test scripts/uom/rebuild-uoms-from-product-names.ts --apply
 */
import { prisma } from '@/lib/db'
import { extractUnits, coverage, canonicalize } from '@/lib/uom/extract-from-product-name'

const APPLY = process.argv.includes('--apply')
/** 提炼出来的单位统一挂这个类目 —— 它们描述的是**包装形态**，不是物理量纲 */
const CATEGORY_NAME = 'Packaging'

async function main() {
  const products = await prisma.product.findMany({
    where: { status: 'ACTIVE', template: { canBeSold: true } },
    select: { name: true },
  })
  const result = extractUnits(products.map(p => p.name))

  console.log(`扫描 ACTIVE 可售商品：${result.totalProducts} 个`)
  console.log(`末词带数字(是规格不是单位，跳过)：${result.skippedNumeric} 个`)
  console.log(`提炼出单位：${result.units.length} 个，覆盖 ${(coverage(result) * 100).toFixed(1)}% 的商品\n`)

  console.log('提炼结果（写法变体已合并）：')
  for (const u of result.units) {
    const vs = u.variants.length > 1
      ? `  ← ${u.variants.map(v => `${v.raw}×${v.count}`).join(', ')}`
      : ''
    console.log(`  ${u.name.padEnd(10)} ${String(u.count).padStart(5)} 个商品${vs}`)
  }

  if (result.rejected.length > 0) {
    console.log('\n末词是纯字母但判为非单位的（核对判据是否过严）：')
    for (const r of result.rejected.slice(0, 15)) {
      console.log(`  ${r.name.padEnd(16)} ${r.count} 个`)
    }
  }

  // ── 与现有 Uom 表比对 ────────────────────────────────────────────────────
  const existing = await prisma.uom.findMany({
    select: { id: true, name: true, nameZh: true, active: true, categoryId: true },
  })
  const existingByCanon = new Map(existing.map(u => [canonicalize(u.name), u]))

  const toCreate = result.units.filter(u => !existingByCanon.has(u.name))
  const extractedSet = new Set(result.units.map(u => u.name))

  // 停用候选：不在提炼结果里的现役单位。用到的不停 —— 先查引用
  const stillActive = existing.filter(u => u.active && !extractedSet.has(canonicalize(u.name)))
  const usage = await Promise.all(stillActive.map(async u => {
    const [saleUomCount, lineCount, tplSale, tplPurchase] = await Promise.all([
      prisma.productSaleUom.count({ where: { uomId: u.id } }),
      prisma.orderLine.count({ where: { uomId: u.id } }),
      prisma.productTemplate.count({ where: { uomId: u.id } }),
      prisma.productTemplate.count({ where: { purchaseUomId: u.id } }),
    ])
    return { uom: u, used: saleUomCount + lineCount + tplSale + tplPurchase }
  }))
  const toDeactivate = usage.filter(x => x.used === 0).map(x => x.uom)
  const keptBecauseUsed = usage.filter(x => x.used > 0)

  console.log(`\n新建单位：${toCreate.length} 个`)
  for (const u of toCreate) console.log(`  + ${u.name}（${u.count} 个商品在用）`)

  console.log(`\n停用自造单位：${toDeactivate.length} 个`)
  for (const u of toDeactivate) console.log(`  - ${u.name}${u.nameZh ? `（${u.nameZh}）` : ''}`)

  if (keptBecauseUsed.length > 0) {
    console.log(`\n⚠️ 以下单位商品名里没有，但**有数据在用**，保留不停用：`)
    for (const x of keptBecauseUsed) {
      console.log(`  ! ${x.uom.name}${x.uom.nameZh ? `（${x.uom.nameZh}）` : ''} — ${x.used} 处引用`)
    }
  }

  if (!APPLY) {
    console.log('\n（dry-run，未改动任何数据。确认无误后加 --apply）')
    return
  }

  const category = await prisma.uomCategory.upsert({
    where: { name: CATEGORY_NAME },
    update: {},
    create: { name: CATEGORY_NAME, nameZh: '包装形态' },
  })

  for (const u of toCreate) {
    await prisma.uom.create({
      data: {
        name: u.name,
        categoryId: category.id,
        // 系数一律 1：换算靠 ProductSaleUom.factor，全局单位不承担这件事
        type: 'REFERENCE',
        factor: 1,
        rounding: 0.01,
        active: true,
      },
    })
  }
  for (const u of toDeactivate) {
    await prisma.uom.update({ where: { id: u.id }, data: { active: false } })
  }

  console.log(`\n✅ 已新建 ${toCreate.length} 个单位，停用 ${toDeactivate.length} 个`)
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1) })
