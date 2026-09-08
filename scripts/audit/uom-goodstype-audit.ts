/**
 * 审计：正在被使用的 Uom，goodsType(大货 BULK / 散货 LOOSE) 配置是否可疑
 * ============================================================================
 * 背景：拣货单打印(lib/print/trip-picking-template.ts belongsToConsumableTable)
 * 唯一依据 Uom.goodsType 决定商品进「整箱整袋」表还是「零散货」表；LOOSE 才展开
 * 客户明细，BULK/未分类一律只显示总量。这个字段挂在全局 Uom 表上，配置入口在
 * Settings→计量单位（Units of Measure）。20260907 实测过一次真实事故：TRAY 被
 * 配成 BULK（应为 LOOSE），导致一个商品被印到错误的表，配置错了代码不会报错、
 * 不会留白，只会在打印出来的实体单据上分错类——很难被系统自己发现。
 *
 * 本脚本用 Uom.name 的结尾词做启发式判断"这个名字看起来应该是散货还是大货"
 * （复用 scripts/archive/backfill-product-uom.ts 里已验证过的词表），跟当前
 * 库里配的 goodsType 做比对，只关心「正在被使用」的 Uom（挂在某个商品的基准
 * 单位 Product.uomId，或某个可售单位 ProductSaleUom.active，或历史订单行
 * OrderLine.uomId 上）——没人用的 Uom 配错了不影响任何单据，不必打扰人工。
 *
 * 只读，不写库；--apply 时对「未分类(null) 且名字能明确判断」的用例直接补全
 * goodsType（新配置，不覆盖已有的人工判断），并把仍然可疑的（已配置但和名字
 * 启发式冲突）打印出来交给人工去 Settings→计量单位 页面核对——这类冲突可能是
 * 名字起得不规范导致的假阳性，不能不问自取，机器不替人做最终判断。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/audit/uom-goodstype-audit.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/audit/uom-goodstype-audit.ts dotenv_config_path=.env.local --apply    # 补全未分类的
 */
import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

// 与 scripts/archive/backfill-product-uom.ts 保持同一词表，避免两处判断标准不一致
const BULK_WORDS = [
  'CASE', 'PKT', 'BAG', 'BOTTLE', 'JAR', 'DRUM', 'PACKET', 'TIN', 'PK', 'PACK',
  'TRAY', 'BOX', 'BUCKET', 'ROLL', 'TUB', 'PALLET', 'PUNNET', 'CTN', 'CARTON',
]
const PUNNET_VARIANTS = new Set(['PUNNET', 'PUNNUT', 'PUNNT'])
const LOOSE_WORDS = ['KG', 'LOOSE', 'G', 'GRAM', 'LB', 'OZ']

type Guess = 'BULK' | 'LOOSE' | null

function lastToken(name: string): string {
  const words = name.trim().split(/\s+/)
  let last = words[words.length - 1] ?? ''
  if (last.includes('/')) {
    const parts = last.split('/')
    last = parts[parts.length - 1]
  }
  return last.toUpperCase().replace(/[.,;:()]+$/, '')
}

/** 数字打头的重量标注（如 "25Kg"/"500g"）是固定规格整袋/整罐，不是散称计量单位，不参与猜测 */
function isNumericWeightLabel(token: string): boolean {
  return /^\d+(\.\d+)?(KG|G|LB|OZ)$/.test(token)
}

function guessGoodsType(uomName: string): Guess {
  const last = lastToken(uomName)
  if (isNumericWeightLabel(last)) return null
  if (LOOSE_WORDS.includes(last)) return 'LOOSE'
  if (PUNNET_VARIANTS.has(last)) return 'BULK'
  if (BULK_WORDS.includes(last)) return 'BULK'
  return null
}

interface UsageRow {
  id: string
  name: string
  nameZh: string | null
  goodsType: string | null
  active: boolean
  base_product_count: number
  sale_uom_count: number
  order_line_count: number
}

async function main() {
  console.log(`\n=== Uom.goodsType 配置审计 (${APPLY ? 'APPLY 补全未分类' : 'DRY-RUN 只读'}) ===\n`)

  const rows = await prisma.$queryRaw<UsageRow[]>`
    SELECT
      u.id, u.name, u."nameZh", u."goodsType", u.active,
      COUNT(DISTINCT p.id)::int   AS base_product_count,
      COUNT(DISTINCT psu.id)::int AS sale_uom_count,
      COUNT(DISTINCT ol.id)::int  AS order_line_count
    FROM "Uom" u
    LEFT JOIN "Product" p ON p."uomId" = u.id
    LEFT JOIN "ProductSaleUom" psu ON psu."uomId" = u.id AND psu.active = true
    LEFT JOIN "OrderLine" ol ON ol."uomId" = u.id
    GROUP BY u.id, u.name, u."nameZh", u."goodsType", u.active
  `

  const inUse = rows.filter(r => r.base_product_count > 0 || r.sale_uom_count > 0 || r.order_line_count > 0)
  console.log(`Uom 总数 ${rows.length}，其中正在被使用（挂基准单位/可售单位/有历史订单行）的 ${inUse.length} 个\n`)

  const unclassifiedInUse = inUse.filter(r => r.goodsType == null)
  const conflicting = inUse.filter(r => {
    const guess = guessGoodsType(r.name)
    return guess != null && r.goodsType != null && guess !== r.goodsType
  })
  const unclassifiedNoGuess = unclassifiedInUse.filter(r => guessGoodsType(r.name) == null)
  const unclassifiedWithGuess = unclassifiedInUse.filter(r => guessGoodsType(r.name) != null)

  console.log('【高危①：已配置但和名字启发式冲突——最像 TRAY 那次事故，请去 Settings→计量单位 核对】')
  if (conflicting.length === 0) {
    console.log('  （无）\n')
  } else {
    for (const r of conflicting.sort((a, b) => (b.sale_uom_count + b.order_line_count) - (a.sale_uom_count + a.order_line_count))) {
      const guess = guessGoodsType(r.name)
      console.log(`  ${r.name.padEnd(24)} 当前=${String(r.goodsType).padEnd(6)} 名字像=${String(guess).padEnd(6)} (可售单位挂载${r.sale_uom_count} 基准商品${r.base_product_count} 历史订单行${r.order_line_count})`)
    }
    console.log('')
  }

  console.log('【高危②：正在使用但未分类(空)——现在会被当作"整箱整袋"处理，如果实际是散货会静默印错表】')
  if (unclassifiedInUse.length === 0) {
    console.log('  （无）\n')
  } else {
    for (const r of unclassifiedInUse.sort((a, b) => (b.sale_uom_count + b.order_line_count) - (a.sale_uom_count + a.order_line_count))) {
      const guess = guessGoodsType(r.name)
      console.log(`  ${r.name.padEnd(24)} 名字像=${String(guess).padEnd(6)} (可售单位挂载${r.sale_uom_count} 基准商品${r.base_product_count} 历史订单行${r.order_line_count})`)
    }
    console.log('')
  }

  console.log(`  其中名字能明确猜出类型的 ${unclassifiedWithGuess.length} 个，名字猜不出（需要人工判断）的 ${unclassifiedNoGuess.length} 个\n`)

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。===')
    console.log('说明：')
    console.log('  ①「已配置但冲突」的，脚本不会自动改——可能是名字起得不规范导致的启发式假阳性，需要人工去 Settings→计量单位 页面核对再改。')
    console.log('  ②「未分类且名字能猜出」的，可以加 --apply 让脚本直接补全（只补空值，不覆盖任何已有配置）。')
    console.log('  ②「未分类且名字猜不出」的，脚本无能为力，需要人工在 Settings→计量单位 页面逐个判断。\n')
    return
  }

  if (unclassifiedWithGuess.length === 0) {
    console.log('=== APPLY：没有可自动补全的未分类项。===\n')
    return
  }

  console.log(`=== APPLY：补全 ${unclassifiedWithGuess.length} 个未分类 Uom 的 goodsType ===\n`)
  let updated = 0
  for (const r of unclassifiedWithGuess) {
    const guess = guessGoodsType(r.name)!
    await prisma.uom.update({ where: { id: r.id }, data: { goodsType: guess } })
    console.log(`  ${r.name.padEnd(24)} → ${guess}`)
    updated++
  }
  console.log(`\n✅ 补全完成：${updated} 个 Uom 写入 goodsType。\n`)
  console.log('⚠️「已配置但冲突」的那批仍未处理，机器不替人做最终判断，请人工去 Settings→计量单位 页面核对。\n')
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
