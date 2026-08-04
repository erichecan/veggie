/**
 * scripts/backfill-odoo-stock-20260717.ts
 *
 * 全量商品导入(import-odoo-products-full-20260717.ts)刻意排除了 qtyOnHand，导致这批商品
 * 库存都是 0。用户要求用 Odoo 真实库存数据回填，但排查发现 veggie 里有 208 个商品已经有
 * 真实的库存流水(StockMove)——不是种子/演示数据，是真实的订单出入库/收货/报废记录，其中
 * 175 个在 2026-07-07 做过一次库存基线初始化，之后叠加了 2026-06-24~07-14 的真实订单流水。
 * 这 208 个就是当前实际在正常进销存的核心品类。而 Odoo 同名商品的库存记录全部停留在
 * 2022-2023 年（个别到 2024-2025），是几年前的旧快照。
 *
 * 用户确认（2026-07-17）：只用 Odoo 库存回填"从未在 veggie 有过真实库存流水"的商品，
 * 不碰这 208 个已有真实近期记录的商品（避免用旧数字冲掉最近两周的真实库存）。
 *
 * 数据来源：scripts/odoo-migration/exports/odoo_internal_stock.csv（Odoo stock_quant 表
 * 里 location.usage='internal'——即真实仓库位置、非 customer/supplier/inventory 等虚拟
 * 过渡位置——且 quantity != 0 的记录，按 product_id 去重取值）。
 *
 * 写法沿用本系统盘点(stock-takes)的既有约定：不直接改 qtyOnHand 字段了事，而是生成一条
 * StockMove(type=ADJUSTMENT, sourceType='ODOO_IMPORT')记录 delta，再用该 delta 去
 * increment qtyOnHand——保持"qtyOnHand == ΣStockMove"这条系统不变量成立。movedAt 用今天
 * （建立 veggie 库存基线的日期），不用 Odoo 那边几年前的 in_date（那只是 Odoo 侧最后一次
 * 变动时间，不代表这是"今天的库存业务日期"）。
 *
 * 不处理 Lot（批次）：这批商品在 veggie 里从来没有过 Lot 记录，Odoo 的库存快照也没有细分
 * 批次/效期信息，强行拆批次反而是编造数据；只在 Product 层面记账，不影响
 * "批次守恒 Lot.currentQty == ΣStockMove(lot)"这条不变量（本次生成的 StockMove 不带 lotId）。
 *
 * 范围：Product 当前 qtyOnHand=0 且从未出现在 StockMove.productId 里（无论 ACTIVE 还是
 * ARCHIVED，都只回填库存数字，不改动 status——是否上架是另一个已经问过、已经决定的问题）。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/backfill-odoo-stock-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/backfill-odoo-stock-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const CSV_PATH = path.join(__dirname, 'odoo-migration/exports/odoo_internal_stock.csv')

function parseCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}
function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split('\n').filter(l => l.trim())
  const headers = parseCSVLine(lines[0])
  return lines.slice(1).map(l => {
    const vals = parseCSVLine(l)
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}
const round3 = (n: number) => Math.round(n * 1000) / 1000

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'))
  console.log(`Odoo 真实仓库库存记录: ${rows.length} 条`)

  const trackedProductIds = new Set(
    (await prisma.stockMove.findMany({ select: { productId: true }, distinct: ['productId'] })).map(m => m.productId)
  )
  console.log(`veggie 里已有真实库存流水的商品: ${trackedProductIds.size} 个（跳过，不动）`)

  const products = await prisma.product.findMany({ select: { id: true, externalId: true, name: true, qtyOnHand: true } })
  const byExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p]))

  const targets: { productId: string; productName: string; qty: number }[] = []
  let skippedTracked = 0
  let skippedNotFound = 0
  let skippedAlreadyNonZero = 0
  for (const r of rows) {
    const prod = byExt.get(r.product_id)
    if (!prod) { skippedNotFound++; continue }
    if (trackedProductIds.has(prod.id)) { skippedTracked++; continue }
    if (Number(prod.qtyOnHand) !== 0) { skippedAlreadyNonZero++; continue }
    const qty = round3(parseFloat(r.quantity))
    if (qty <= 0) continue
    targets.push({ productId: prod.id, productName: prod.name, qty })
  }

  console.log(`\n计划回填: ${targets.length} 个商品`)
  console.log(`跳过（已有真实流水历史）: ${skippedTracked}`)
  console.log(`跳过（Odoo product_id 在 veggie 里找不到）: ${skippedNotFound}`)
  console.log(`跳过（qtyOnHand 已非 0，不属于本次范围）: ${skippedAlreadyNonZero}`)
  console.log('样例（前10个）:')
  for (const t of targets.slice(0, 10)) console.log(`  - ${t.productName}: +${t.qty}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    await prisma.$disconnect()
    return
  }

  let done = 0
  for (const t of targets) {
    await prisma.stockMove.create({
      data: {
        productId: t.productId,
        productName: t.productName,
        type: 'ADJUSTMENT',
        qty: t.qty,
        note: `Odoo 历史数据导入库存回填（Odoo 仓库快照，来源存在滞后）`,
        sourceType: 'ODOO_IMPORT',
      },
    })
    await prisma.product.update({ where: { id: t.productId }, data: { qtyOnHand: { increment: t.qty } } })
    done++
    if (done % 200 === 0) console.log(`  ...进度 ${done}/${targets.length}`)
  }
  console.log(`\n✅ 完成：回填 ${done} 个商品的库存`)
  await prisma.$disconnect()
}

main().catch(e => { console.error(e); process.exit(1) })
