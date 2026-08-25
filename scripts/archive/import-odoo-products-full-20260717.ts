/**
 * scripts/import-odoo-products-full-20260717.ts
 *
 * 全量数据迁移 Phase 3c：从本地 Odoo 镜像库导出全部 5,477 个 product_product 变体
 * （scripts/odoo-migration/exports/product_product.csv），补齐 2026-07-15 那次只导入
 * "Can be Sold" 1,677 条的缺口。
 *
 * 为什么要导入 Odoo 里已归档 / 不可售的商品：Phase 4（15 万单历史订单）的
 * OrderLine.productId 是真实外键（ON DELETE RESTRICT），任何历史订单行引用的商品必须
 * 先在 Product 表里存在才能导入订单——哪怕那个商品早就在 Odoo 下架了。这批商品导入后
 * 默认按 Odoo 的 active 状态映射为 ACTIVE/ARCHIVED，不会出现在正常下单页面。
 *
 * 沿用 2026-07-15 商品同步（scripts/sync-odoo-products-20260715.ts）确立的模式：
 * 原地覆盖 + 归档，不物理删除；同一份 TAX_RATE_MAP（已核对覆盖全部 5,477 条，无遗漏）。
 *
 * ⚠️ 刻意排除的字段（本系统自己的运营数据，Odoo 导出不得覆盖）：
 *   qtyOnHand / stock / safetyStockMin / currentZoneId / uomId —— 同 20260715 脚本。
 *
 * 匹配规则（沿用 veggie 既有约定，非 Odoo 原生结构）：
 *   - product_product.id → Product.externalId
 *   - ProductTemplate.externalId 与其唯一 Product.externalId 取同一个值（1:1，
 *     不使用 Odoo 真实的 product_template.id）——这是本系统早先建立的简化约定，继续沿用
 *   - category_external_id → ProductCategory.externalId（Phase 3a 已同步）
 *   - tax_ext → customerTaxRate（TAX_RATE_MAP 静态映射）
 *   - variant_active=t → status=ACTIVE；variant_active=f → status=ARCHIVED
 *
 * 处理：
 *   - Odoo 有、本地没有（按 externalId）→ 新建 Product + 配套 ProductTemplate
 *   - 匹配上 → 原地刷新目录字段 + 按 Odoo active 状态同步 ACTIVE/ARCHIVED
 *   - 不做"本地有、Odoo 没有"的归档判断：这次导出是 Odoo 全量（含已归档），
 *     覆盖面已经是本地不可能超出的上限
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-products-full-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-products-full-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入（会先备份）
 *
 * 回滚：--apply 前会把当前全部 Product 整表快照写到
 *   scripts/.backup-products-pre-20260717.json
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const CSV_PATH = path.join(__dirname, 'odoo-migration/exports/product_product.csv')
const BACKUP_PATH = path.join(__dirname, '.backup-products-pre-20260717.json')

// 与 20260715 脚本完全一致，已核对覆盖本次全量 5,477 条商品的全部 3 种非空税率外部ID
const TAX_RATE_MAP: Record<string, number> = {
  '__export__.account_tax_4_2705eab1': 0,
  'l10n_generic_coa.1_sale_tax_template': 0.23,
  '__export__.account_tax_3_42b1e19b': 0.135,
}

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

async function main() {
  const rows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'))
  console.log(`CSV 解析：${rows.length} 条商品变体`)

  const cats = await prisma.productCategory.findMany({ select: { id: true, externalId: true } })
  const catByExt = new Map(cats.filter(c => c.externalId).map(c => [c.externalId as string, c.id]))

  const localProds = await prisma.product.findMany({
    select: { id: true, templateId: true, externalId: true, name: true, status: true },
  })
  const localByExt = new Map(localProds.filter(p => p.externalId).map(p => [p.externalId as string, p]))

  const toUpdate = rows.filter(r => localByExt.has(r.external_id))
  const toCreate = rows.filter(r => !localByExt.has(r.external_id))

  const activateCount = toUpdate.filter(r => r.variant_active === 't' && localByExt.get(r.external_id)!.status === 'ARCHIVED').length
  const archiveCount = toUpdate.filter(r => r.variant_active === 'f' && localByExt.get(r.external_id)!.status !== 'ARCHIVED').length
  const createArchivedCount = toCreate.filter(r => r.variant_active === 'f').length

  console.log(`\n计划：刷新 ${toUpdate.length}（其中重新上架 ${activateCount} / 归档 ${archiveCount}）`)
  console.log(`      新建 ${toCreate.length}（其中直接以 ARCHIVED 状态新建 ${createArchivedCount}，仅用于满足历史订单外键）`)
  console.log('\n新建样例(前5，含已归档)：')
  for (const r of toCreate.slice(0, 5)) console.log(`  [${r.external_id}] ${r.name} | active=${r.variant_active} | €${r.list_price}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(localProds, null, 2))
  console.log(`\n已备份当前 ${localProds.length} 条商品记录到 ${BACKUP_PATH}`)

  let updated = 0, created = 0
  for (const r of toUpdate) {
    const cur = localByExt.get(r.external_id)!
    const categoryId = r.category_external_id ? (catByExt.get(r.category_external_id) ?? null) : null
    const customerTaxRate = r.tax_ext && r.tax_ext in TAX_RATE_MAP ? TAX_RATE_MAP[r.tax_ext] : undefined
    const status = r.variant_active === 't' ? 'ACTIVE' : 'ARCHIVED'
    const data: Record<string, unknown> = {
      name: r.name,
      internalRef: r.default_code || undefined,
      listPrice: toNum(r.list_price),
      standardPrice: toNum(r.standard_price),
      commissionPrice: toNum(r.commission_price),
      status,
    }
    if (categoryId) data.categoryId = categoryId
    if (customerTaxRate !== undefined) data.customerTaxRate = customerTaxRate

    await prisma.product.update({ where: { id: cur.id }, data: data as never })
    await prisma.productTemplate.update({
      where: { id: cur.templateId },
      data: {
        name: r.name,
        internalRef: r.default_code || undefined,
        listPrice: toNum(r.list_price),
        standardPrice: toNum(r.standard_price),
        weight: toNum(r.weight),
        commissionPrice: toNum(r.commission_price),
        status,
        ...(categoryId ? { categoryId } : {}),
        ...(customerTaxRate !== undefined ? { customerTaxRate } : {}),
      } as never,
    })
    updated++
    if (updated % 500 === 0) console.log(`  ...刷新进度 ${updated}/${toUpdate.length}`)
  }

  for (const r of toCreate) {
    const categoryId = r.category_external_id ? (catByExt.get(r.category_external_id) ?? null) : null
    const customerTaxRate = r.tax_ext && r.tax_ext in TAX_RATE_MAP ? TAX_RATE_MAP[r.tax_ext] : 0
    const status = r.variant_active === 't' ? 'ACTIVE' : 'ARCHIVED'
    const tmpl = await prisma.productTemplate.create({
      data: {
        name: r.name,
        internalRef: r.default_code || undefined,
        listPrice: toNum(r.list_price),
        standardPrice: toNum(r.standard_price),
        weight: toNum(r.weight),
        commissionPrice: toNum(r.commission_price),
        externalId: r.external_id,
        status,
        categoryId: categoryId ?? undefined,
        customerTaxRate,
      },
    })
    await prisma.product.create({
      data: {
        templateId: tmpl.id,
        name: r.name,
        internalRef: r.default_code || undefined,
        listPrice: toNum(r.list_price),
        standardPrice: toNum(r.standard_price),
        commissionPrice: toNum(r.commission_price),
        externalId: r.external_id,
        status,
        categoryId: categoryId ?? undefined,
        customerTaxRate,
      },
    })
    created++
    if (created % 500 === 0) console.log(`  ...新建进度 ${created}/${toCreate.length}`)
  }

  console.log(`\n✅ 完成：刷新 ${updated} / 新建 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
