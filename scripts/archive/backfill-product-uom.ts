/**
 * 订正脚本：按商品名后缀回填 ProductTemplate.uomId（散称 vs 包装）
 *
 * 背景：客户要求拣货单只对「散称/按重量现称」的商品（裸 KG / LOOSE 后缀）展示
 * 客户拆分明细，其余按件/箱/包/固定规格卖的商品只显示总量。目前没有任何结构化
 * 字段记录这个区分——Uom/UomCategory 模型设计时预留了 Uom.goodsType(BULK/LOOSE)
 * 字段用于此目的，但 ProductTemplate.uomId 全库 1718 行 100% 为空，从未接线。
 *
 * 本脚本一次性把 1718 个商品名的「结尾词」解析成 LOOSE/BULK 分类，
 * 复用已有的 kg Uom（Weight 分类，已标 LOOSE），为每个包装词新建一个
 * Uom（归到「件数」分类，标 BULK），并把 ProductTemplate.uomId 指过去。
 * 以后任何统计/功能都可以直接读 ProductTemplate.uomId → Uom.goodsType，
 * 不用再猜测商品名。
 *
 * 分类规则（按最后一个 token 判断，"/" 复合词取最后一段，如 "3KG/CASE"→CASE）：
 *   LOOSE：裸 "KG"（如 "Broccoli KG"）、裸 "LOOSE"
 *   BULK ：CASE / PKT / BAG / BOTTLE / JAR / DRUM / PACKET / TIN / PK / PACK /
 *          TRAY / BOX / BUCKET / ROLL / TUB / PALLET / PUNNET(含 PUNNUT/PUNNT 拼写变体)
 *   未匹配：uomId=null（含「数字+KG/G」如 "25Kg"/"500g"——这是固定规格整袋/整罐/
 *           整瓶的重量标注，不是散称计量单位，按件数拣货，不需要客户拆分；
 *           另含测试/折扣类非库存行）
 *
 * 幂等：每次运行都重新分类全部 1718 行并覆盖写入（含清空不再匹配的 uomId），
 * 不是只处理 uomId 为空的行——用于修正上一版规则的误判，可反复重跑收敛。
 *
 * 用法：
 *   node --import tsx -r dotenv/config scripts/backfill-product-uom.ts dotenv_config_path=.env.local            # dry-run（只读统计，绝不写库）
 *   node --import tsx -r dotenv/config scripts/backfill-product-uom.ts dotenv_config_path=.env.local --apply    # 建 Uom + 写 ProductTemplate.uomId
 */

import { createPrismaClient } from '@/lib/prisma-factory'
const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')

const BULK_WORDS = [
  'CASE', 'PKT', 'BAG', 'BOTTLE', 'JAR', 'DRUM', 'PACKET', 'TIN', 'PK', 'PACK',
  'TRAY', 'BOX', 'BUCKET', 'ROLL', 'TUB', 'PALLET', 'PUNNET',
]
const PUNNET_VARIANTS = new Set(['PUNNET', 'PUNNUT', 'PUNNT'])

type Bucket = 'LOOSE_KG' | 'LOOSE' | `BULK_${string}` | 'UNMATCHED'

function lastToken(name: string): string {
  const words = name.trim().split(/\s+/)
  let last = words[words.length - 1] ?? ''
  if (last.includes('/')) {
    const parts = last.split('/')
    last = parts[parts.length - 1]
  }
  return last.toUpperCase().replace(/[.,;:()]+$/, '')
}

function classify(name: string): Bucket {
  const last = lastToken(name)
  if (last === 'KG') return 'LOOSE_KG'
  if (last === 'LOOSE') return 'LOOSE'
  const bulkWord = PUNNET_VARIANTS.has(last) ? 'PUNNET' : (BULK_WORDS.includes(last) ? last : null)
  if (bulkWord) return `BULK_${bulkWord}` as Bucket
  return 'UNMATCHED'
}

async function main() {
  console.log(`\n=== 商品 UOM 回填（散称 vs 包装） (${APPLY ? 'APPLY 写库' : 'DRY-RUN 只读'}) ===\n`)

  const templates = await prisma.productTemplate.findMany({
    select: { id: true, name: true },
  })
  console.log(`ProductTemplate 共 ${templates.length} 行（本脚本幂等，每次全量重新分类并覆盖写入）\n`)

  const byBucket = new Map<Bucket, typeof templates>()
  for (const t of templates) {
    const b = classify(t.name)
    if (!byBucket.has(b)) byBucket.set(b, [])
    byBucket.get(b)!.push(t)
  }

  console.log('【分类统计】')
  const sorted = [...byBucket.entries()].sort((a, b) => b[1].length - a[1].length)
  for (const [bucket, rows] of sorted) {
    console.log(`  ${bucket.padEnd(12)} : ${rows.length}`)
  }
  console.log('')

  const unmatched = byBucket.get('UNMATCHED') ?? []
  console.log(`【未匹配样本】共 ${unmatched.length}（uomId=null，不影响拣货单——按总量展示）`)
  for (const t of unmatched.slice(0, 30)) console.log(`   - ${t.name}`)
  if (unmatched.length > 30) console.log(`   ... 还有 ${unmatched.length - 30} 个`)
  console.log('')

  // 需要用到的 Uom：LOOSE_KG→复用 kg，LOOSE→新建 "LOOSE"，BULK_*→新建对应包装词
  const weightCategory = await prisma.uomCategory.findFirst({ where: { name: { equals: 'Weight', mode: 'insensitive' } } })
  const unitCategory = await prisma.uomCategory.findFirst({
    where: { OR: [{ name: { contains: 'unit', mode: 'insensitive' } }, { nameZh: { contains: '件' } }] },
  })
  if (!weightCategory || !unitCategory) {
    console.error('❌ 找不到 Weight 或 件数/Unit 分类，请先检查 Uom 种子数据。')
    process.exit(1)
  }
  const kgUom = await prisma.uom.findFirst({ where: { categoryId: weightCategory.id, name: { equals: 'kg', mode: 'insensitive' } } })
  if (!kgUom) {
    console.error('❌ 找不到已有的 kg Uom（Weight 分类），请先检查 Uom 种子数据。')
    process.exit(1)
  }
  console.log(`复用现有 Uom：kg=${kgUom.id}(goodsType=${kgUom.goodsType})\n`)

  // LOOSE 新 Uom + 每个 BULK 包装词一个新 Uom（若不存在才创建）
  const newUomNames = new Set<string>()
  if (byBucket.has('LOOSE')) newUomNames.add('LOOSE')
  for (const b of byBucket.keys()) {
    if (b.startsWith('BULK_')) newUomNames.add(b.slice('BULK_'.length))
  }

  const uomIdByName = new Map<string, string>()
  uomIdByName.set('__KG__', kgUom.id)

  for (const name of newUomNames) {
    const existing = await prisma.uom.findFirst({ where: { categoryId: unitCategory.id, name: { equals: name, mode: 'insensitive' } } })
    if (existing) {
      uomIdByName.set(name, existing.id)
      console.log(`  Uom 已存在，复用：${name} → ${existing.id} (goodsType=${existing.goodsType})`)
      continue
    }
    const goodsType = name === 'LOOSE' ? 'LOOSE' : 'BULK'
    console.log(`  ${APPLY ? '创建' : '[将创建]'} Uom：${name}（分类=${unitCategory.name}，goodsType=${goodsType}）`)
    if (APPLY) {
      const created = await prisma.uom.create({
        data: { name, categoryId: unitCategory.id, goodsType },
      })
      uomIdByName.set(name, created.id)
    }
  }
  console.log('')

  if (!APPLY) {
    console.log('=== DRY-RUN 结束，未写任何数据。确认无误后加 --apply 执行订正。===\n')
    return
  }

  // ---- APPLY：按分类批量写 ProductTemplate.uomId（每类一条 UPDATE，而非逐行往返）----
  // UNMATCHED 也要显式清空，修正上一版把「数字+KG/G」误判为 LOOSE 时写入的 uomId。
  let updated = 0
  for (const [bucket, rows] of byBucket.entries()) {
    if (rows.length === 0) continue
    const uomId =
      bucket === 'UNMATCHED' ? null
      : bucket === 'LOOSE_KG' ? uomIdByName.get('__KG__')
      : bucket === 'LOOSE' ? uomIdByName.get('LOOSE')
      : uomIdByName.get(bucket.slice('BULK_'.length))
    if (uomId === undefined) continue
    const ids = rows.map(t => t.id)
    const res = uomId === null
      ? await prisma.$executeRaw`UPDATE "ProductTemplate" SET "uomId" = NULL WHERE id = ANY(${ids})`
      : await prisma.$executeRaw`UPDATE "ProductTemplate" SET "uomId" = ${uomId} WHERE id = ANY(${ids})`
    updated += res
    console.log(`  ${bucket.padEnd(12)} → uomId=${uomId ?? 'NULL'}  已更新 ${res} 行`)
  }
  console.log(`\n✅ 订正完成：ProductTemplate.uomId 写入 ${updated} 行。\n`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
