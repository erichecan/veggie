/**
 * scripts/import-odoo-pricelists-full-20260717.ts
 *
 * 全量数据迁移 Phase 3d：从本地 Odoo 镜像库导出的全部 112 张 product_pricelist +
 * 4,012 条 product_pricelist_item（scripts/odoo-migration/exports/pricelist_items.csv,
 * pricelist_customer_counts.csv）同步 OdooPricelist。
 *
 * ⚠️ 沿用用户 2026-07-15 已做出的判断（"0 客户关联的历史垃圾数据，需要彻底删除"）：
 * 只同步「至少关联 1 个客户」的价格表（112 条里 81 条），零关联的 30 条一律跳过，不新建、
 * 不触碰生产库里可能残留的同名记录（本次比对发现生产库仍有 2 条零关联的
 * TEST PL.BASE / HanSung Market菜，不属于这次导入范围，不做处理，留给运营判断是否要删）。
 *
 * 比对结果（20260717）：81 条里生产库已有 73 条（用既有的 __export__.product_pricelist_
 * <id>_<hash> XML External ID 里的数字反解匹配），8 条全新；已匹配的 73 条里，
 * items 明细存在明显缺口（例如 MUSASHI 镜像库 184 条 vs 生产库 145 条），本次一并刷新，
 * 不只是新建那 8 条。
 *
 * 匹配规则：
 *   - pricelist_ext_id 与生产库 OdooPricelist.externalId 里 __export__.product_pricelist_
 *     <id>_ 的数字部分比对（历史遗留），或直接数字相等（新建的沿用这个更简单的格式）
 *   - 新建时 id 沿用生产库里已有的 "pl_<odooId>" 主键约定（而不是默认 cuid），
 *     与 CustomerPricelist.pricelistId 的引用习惯保持一致
 *   - items[].productVariantId ← 按 product_id 反查 Product.externalId → Product.id
 *   - items[].productTemplateId ← 按 product_tmpl_id 反查 Product.externalId → Product.templateId
 *     （本系统 product_template 与 product_product 全部 1:1，20260717 已核实全部 5,477
 *     个模板都只有 1 个变体，不存在"一个模板对应哪个变体"的歧义）
 *   - items[].basedOnPricelistId ← 按 base_pricelist_id 反查同一批 OdooPricelist 的 id
 *   - applied_on 原始值 0_product_variant/1_product/3_global → variant/product/global
 *   - compute_price 原始值 fixed/formula/percentage 直接透传（与生产库既有 JSON 结构一致）
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-pricelists-full-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-pricelists-full-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 *
 * 前置依赖：必须先跑完 import-odoo-products-full-20260717.ts --apply（productVariantId/
 * productTemplateId 解析依赖全量 Product.externalId 已经导入完整）。
 *
 * 回滚：--apply 前会把当前全部 OdooPricelist 整表快照写到
 *   scripts/.backup-pricelists-pre-20260717.json
 */
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const ITEMS_CSV = path.join(__dirname, 'odoo-migration/exports/pricelist_items.csv')
const COUNTS_CSV = path.join(__dirname, 'odoo-migration/exports/pricelist_customer_counts.csv')
const PRODUCTS_CSV = path.join(__dirname, 'odoo-migration/exports/product_product.csv')
const BACKUP_PATH = path.join(__dirname, '.backup-pricelists-pre-20260717.json')

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
  const physicalLines = raw.split('\n')
  const rows: string[][] = []
  let buf = ''
  for (const pl of physicalLines) {
    buf = buf ? buf + '\n' + pl : pl
    const quoteCount = (buf.match(/"/g) ?? []).length
    if (quoteCount % 2 === 0) {
      if (buf.trim().length > 0) rows.push(parseCSVLine(buf))
      buf = ''
    }
  }
  const headers = rows[0]
  return rows.slice(1).map(vals => {
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    return row
  })
}
const toNum = (s: string, d = 0) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d }
const APPLY_ON_MAP: Record<string, string> = {
  '0_product_variant': 'variant',
  '1_product': 'product',
  '2_product_category': 'category',
  '3_global': 'global',
}
function extractNumId(externalId: string): string | null {
  const m = externalId.match(/product_pricelist_(\d+)_/)
  if (m) return m[1]
  if (/^\d+$/.test(externalId)) return externalId
  return null
}

async function main() {
  const itemRows = parseCsv(fs.readFileSync(ITEMS_CSV, 'utf-8'))
  const countRows = parseCsv(fs.readFileSync(COUNTS_CSV, 'utf-8'))
  const validPricelistIds = new Set(countRows.filter(r => toNum(r.customer_cnt) > 0).map(r => r.pricelist_ext_id))
  console.log(`Odoo 价格表总数 ${countRows.length}，其中有客户关联 ${validPricelistIds.size} 条（本次同步范围）`)

  const itemsByPl = new Map<string, Record<string, string>[]>()
  for (const r of itemRows) {
    if (!validPricelistIds.has(r.pricelist_ext_id)) continue
    if (!itemsByPl.has(r.pricelist_ext_id)) itemsByPl.set(r.pricelist_ext_id, [])
    itemsByPl.get(r.pricelist_ext_id)!.push(r)
  }
  const plNames = new Map(itemRows.map(r => [r.pricelist_ext_id, r.pricelist_name]))

  const existingPricelists = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true, name: true } })
  const byNumId = new Map<string, { id: string; externalId: string | null; name: string }>()
  for (const p of existingPricelists) {
    if (!p.externalId) continue
    const num = extractNumId(p.externalId)
    if (num) byNumId.set(num, p)
  }

  const products = await prisma.product.findMany({ select: { id: true, templateId: true, externalId: true } })
  const productByExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p]))

  // Odoo 的 product_tmpl_id（真实模板ID）≠ product_product.id（变体ID，本库 externalId 用的是这个）
  // 20260717 已核实两者数值相等的只有约 1501/5477 条，不能假设相等，必须走这份导出里的
  // template_external_id → external_id 映射（见 import-odoo-products-full-20260717.ts 的导出）
  const productRows = parseCsv(fs.readFileSync(PRODUCTS_CSV, 'utf-8'))
  const tmplIdToVariantExtId = new Map(productRows.map(r => [r.template_external_id, r.external_id]))

  // 价格表自引用（formula base=pricelist）需要先知道全部价格表的 id（含即将新建的）
  const plIdByNumId = new Map<string, string>()
  for (const [num, p] of byNumId) plIdByNumId.set(num, p.id)
  for (const numId of validPricelistIds) {
    if (!plIdByNumId.has(numId)) plIdByNumId.set(numId, `pl_${numId}`)
  }

  function buildItem(r: Record<string, string>): Record<string, unknown> | null {
    const applyOn = APPLY_ON_MAP[r.applied_on] ?? 'global'
    const computeType = r.compute_price
    const item: Record<string, unknown> = {
      id: randomUUID(),
      minQty: toNum(r.min_quantity),
      applyOn,
      sequence: toNum(r.sequence, 10),
      computeType,
    }
    if (r.date_start) item.dateStart = r.date_start
    if (r.date_end) item.dateEnd = r.date_end

    if (computeType === 'fixed') {
      item.fixedPrice = toNum(r.fixed_price)
    } else if (computeType === 'percentage') {
      item.percentDiscount = toNum(r.percent_price)
    } else if (computeType === 'formula') {
      item.formulaBase = r.base
      item.priceDiscount = toNum(r.price_discount)
      item.priceSurcharge = toNum(r.price_surcharge)
      if (r.base === 'pricelist' && r.base_pricelist_id) {
        const basedOnId = plIdByNumId.get(r.base_pricelist_id)
        if (basedOnId) item.basedOnPricelistId = basedOnId
      }
    }
    if (toNum(r.price_min_margin) !== 0) item.priceMinMargin = toNum(r.price_min_margin)
    if (toNum(r.price_max_margin) !== 0) item.priceMaxMargin = toNum(r.price_max_margin)

    if (applyOn === 'variant') {
      const prod = productByExt.get(r.product_id)
      if (!prod) return null // 商品未导入（理论上不该发生，Phase 3c 已全量导入）
      item.productVariantId = prod.id
    } else if (applyOn === 'product') {
      // product 级规则的商品引用存在 product_tmpl_id 列（product_id 此时为空），
      // 且 product_tmpl_id 与变体的 product_id 数值不相等，必须先经 template→variant
      // 映射表转换，再按变体的 externalId 反查
      const variantExtId = tmplIdToVariantExtId.get(r.product_tmpl_id)
      const prod = variantExtId ? productByExt.get(variantExtId) : undefined
      if (!prod) return null
      item.productTemplateId = prod.templateId
    }
    return item
  }

  const plan: { numId: string; name: string; existing: { id: string; externalId: string | null; name: string } | null; items: Record<string, unknown>[]; skipped: number }[] = []
  for (const [numId, rows] of itemsByPl) {
    const existing = byNumId.get(numId) ?? null
    const items: Record<string, unknown>[] = []
    let skipped = 0
    for (const r of rows) {
      const item = buildItem(r)
      if (item) items.push(item)
      else skipped++
    }
    plan.push({ numId, name: plNames.get(numId) ?? '', existing, items, skipped })
  }

  const toCreate = plan.filter(p => !p.existing)
  const toUpdate = plan.filter(p => p.existing)
  const totalSkipped = plan.reduce((s, p) => s + p.skipped, 0)

  console.log(`\n计划：刷新 ${toUpdate.length} 张 / 新建 ${toCreate.length} 张（跳过无法解析商品的行 ${totalSkipped} 条）`)
  console.log('\n新建列表：')
  for (const p of toCreate) console.log(`  [${p.numId}] ${p.name} | ${p.items.length} 条明细`)
  console.log('\n刷新样例(前5，展示明细条数变化)：')
  for (const p of toUpdate.slice(0, 5)) {
    console.log(`  [${p.numId}] ${p.name} | 新明细 ${p.items.length} 条`)
  }

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(existingPricelists, null, 2))
  console.log(`\n已备份当前 ${existingPricelists.length} 张价格表到 ${BACKUP_PATH}`)

  let updated = 0, created = 0
  for (const p of toUpdate) {
    await prisma.odooPricelist.update({
      where: { id: p.existing!.id },
      data: { items: p.items as never },
    })
    updated++
  }
  for (const p of toCreate) {
    await prisma.odooPricelist.create({
      data: {
        id: `pl_${p.numId}`,
        externalId: p.numId,
        name: p.name,
        items: p.items as never,
      },
    })
    created++
  }
  console.log(`\n✅ 完成：刷新 ${updated} / 新建 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
