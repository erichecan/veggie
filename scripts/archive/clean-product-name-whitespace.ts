/**
 * 清洗商品名里的连续空格 / 首尾空白（20260819）
 * ============================================================================
 * 客户报「搜不到 ICE Black Tiger Shrimp」，根因之一是库里那条商品叫
 *   `ASIAN CHOICE␣␣Black Tiger Shrimp HOSO 31/40 700g PKT`
 * ——「ASIAN CHOICE」后面是**两个空格**。用户按屏幕上看到的样子输入单空格，
 * 子串匹配一路失败。生产库快照（20260819）里这样的商品名有 69 个，
 * 首尾带空白的有 5 个。它们对所有跨越那个空格的搜索词都是隐身的。
 *
 * 搜索侧已经做了空白归一（`lib/search-rank.ts`），所以这个脚本**不是**修 bug 的必要条件，
 * 而是把脏数据本身洗干净：名字会被打印进送货单、发票、报价单 PDF，
 * 双空格在纸面上同样难看，且导出到 Excel 后别人按名字做 VLOOKUP 一样对不上。
 *
 * ⛔ 只动 `ProductTemplate.name` 与 `Product.name` 的**空白**，不改任何一个字符。
 *    历史 OrderLine 上存的是 `productName` 快照，不受影响也不该受影响 ——
 *    那是当时开出去的单据上印的名字。
 *
 * 用法：
 *   npx tsx --env-file=.env.test scripts/clean-product-name-whitespace.ts          # dry-run
 *   npx tsx --env-file=.env.test scripts/clean-product-name-whitespace.ts --apply  # 真改
 */
import { prisma } from '@/lib/db'

const APPLY = process.argv.includes('--apply')

/** 连续空白压成一个空格 + 去首尾。与 lib/search-rank.ts 的 squashSpace 同口径 */
function squash(name: string): string {
  return name.replace(/\s+/g, ' ').trim()
}

async function main() {
  const [templates, products] = await Promise.all([
    prisma.productTemplate.findMany({ select: { id: true, name: true } }),
    prisma.product.findMany({ select: { id: true, name: true } }),
  ])

  const tplDirty = templates.filter(t => squash(t.name) !== t.name)
  const prodDirty = products.filter(p => squash(p.name) !== p.name)

  console.log(`ProductTemplate：${tplDirty.length} / ${templates.length} 条名字有多余空白`)
  console.log(`Product：        ${prodDirty.length} / ${products.length} 条名字有多余空白`)

  const sample = [...tplDirty, ...prodDirty].slice(0, 15)
  if (sample.length > 0) {
    console.log('\n样例（方括号标出实际边界）：')
    for (const r of sample) {
      console.log(`  [${r.name}]`)
      console.log(`  → [${squash(r.name)}]`)
    }
  }

  if (!APPLY) {
    console.log('\n（dry-run，未改动任何数据。确认无误后加 --apply）')
    return
  }

  let n = 0
  for (const t of tplDirty) {
    await prisma.productTemplate.update({ where: { id: t.id }, data: { name: squash(t.name) } })
    n++
  }
  for (const p of prodDirty) {
    await prisma.product.update({ where: { id: p.id }, data: { name: squash(p.name) } })
    n++
  }
  console.log(`\n✅ 已更新 ${n} 条记录`)
}

main()
  .then(() => process.exit(0))
  .catch(e => { console.error(e); process.exit(1) })
