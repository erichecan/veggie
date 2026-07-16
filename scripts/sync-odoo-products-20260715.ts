/**
 * scripts/sync-odoo-products-20260715.ts
 *
 * 一次性数据刷新：用 Odoo(m.johnstonebros.ie) Product Variants 列表("Can be Sold" 筛选，
 * 1677 条，product.product (1).csv)刷新本系统商品目录，修复价格表明细因本地商品目录
 * 缺口而跳过的问题(2026-07-15 价格表导入时发现 363 条规则的商品本地不存在)。
 *
 * 沿用 2026-07-14 供应商同步(scripts/import-odoo-vendors-20260714.ts)确立的模式：
 * 原地覆盖 + 归档，不物理删除。
 *
 * ⚠️ 刻意排除的字段(本系统自己的运营数据，Odoo 导出不得覆盖)：
 *   - qtyOnHand / stock / safetyStockMin：库存由本系统收货/出库/盘点驱动，早已与 Odoo 脱钩
 *   - currentZoneId：仓库实际温区定位，本系统独有
 *   - uomId：LOOSE/BULK 散称分类，本系统按商品名后缀自行推导(见 backfill-product-uom.ts)，
 *            与 Odoo 的 uom_id 完全是两套体系，不相关
 *
 * 覆盖范围：name / internalRef / listPrice / standardPrice / weight / commissionPrice /
 *          categoryId / customerTaxRate(按静态映射表，见 TAX_RATE_MAP) / status(重新上架)
 *
 * 匹配规则：
 *   - CSV "id" = __export__.product_product_<num>_<hash> → Product.externalId(纯数字)
 *   - CSV "categ_id/id" → ProductCategory.externalId
 *   - 本地 ProductTemplate.externalId 约定与其唯一 Product.externalId 相同(1:1，非 Odoo 的
 *     product_template 真实 ID)，新建商品沿用此约定，不使用 CSV 的 product_tmpl_id/id
 *
 * 处理：
 *   - CSV 有、本地没有 → 新建 Product + 配套 ProductTemplate(56 条)
 *   - 匹配上 → 原地刷新目录字段，若此前 status=ARCHIVED 则重新置 ACTIVE(1621 条)
 *   - 本地 status≠ARCHIVED 但 CSV(可售)里已不存在 → 归档 status=ARCHIVED，不物理删除(97 条候选)
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/sync-odoo-products-20260715.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/sync-odoo-products-20260715.ts dotenv_config_path=.env.local --apply    # 实际写入(会先备份)
 *
 * 回滚：--apply 前会把当前全部 Product 整表快照写到
 *   scripts/.backup-products-pre-20260715.json，需要回滚时按 externalId 手工核对该文件即可。
 */
import fs from 'fs'
import path from 'path'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const BACKUP_PATH = path.join(__dirname, '.backup-products-pre-20260715.json')

// Odoo Customer Tax 外部ID → 本地 customerTaxRate（从现有 1620 条匹配商品的真实分布反推，
// 三个值各自 100% 一致，无歧义）
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
function parseCSVRows(raw: string): string[][] {
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
  return rows
}
const numFromExt = (s: string) => { const m = s.match(/product_product_(\d+)/); return m ? m[1] : '' }
const toNum = (s: string, d = 0) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d }

interface CsvRow {
  num: string
  name: string
  description: string
  lstPrice: number
  stdPrice: number
  defaultCode: string
  weight: number
  commission: number
  categExt: string
  taxExt: string
}

async function main() {
  const raw = fs.readFileSync(path.join(process.cwd(), 'pic/product.product.csv'), 'utf-8').replace(/\r\n/g, '\n')
  const rows = parseCSVRows(raw)
  const header = rows[0]
  const col = (r: string[], name: string) => {
    const i = header.indexOf(name)
    if (i === -1) throw new Error(`CSV 缺少列: ${name}`)
    return r[i] ?? ''
  }

  const csvRows: CsvRow[] = []
  for (const r of rows.slice(1)) {
    const num = numFromExt(col(r, 'id'))
    if (!num) continue
    csvRows.push({
      num,
      name: col(r, 'name').trim(),
      description: col(r, 'description_sale').trim(),
      lstPrice: toNum(col(r, 'lst_price')),
      stdPrice: toNum(col(r, 'standard_price')),
      defaultCode: col(r, 'default_code').trim(),
      weight: toNum(col(r, 'weight')),
      commission: toNum(col(r, 'commission_price_product')),
      categExt: col(r, 'categ_id/id').trim(),
      taxExt: col(r, 'taxes_id/id').trim(),
    })
  }
  console.log(`CSV 解析：${csvRows.length} 条有效商品行（原始 ${rows.length - 1} 行）`)

  const cats = await prisma.productCategory.findMany({ select: { id: true, externalId: true } })
  const catByExt = new Map(cats.filter(c => c.externalId).map(c => [c.externalId as string, c.id]))

  const localProds = await prisma.product.findMany({ select: { id: true, templateId: true, externalId: true, name: true, status: true } })
  const localByNum = new Map(localProds.filter(p => p.externalId && /^\d+$/.test(p.externalId)).map(p => [p.externalId as string, p]))

  const csvNumSet = new Set(csvRows.map(r => r.num))
  const toUpdate = csvRows.filter(r => localByNum.has(r.num))
  const toCreate = csvRows.filter(r => !localByNum.has(r.num))
  const toArchive = localProds.filter(p => p.externalId && /^\d+$/.test(p.externalId) && p.status !== 'ARCHIVED' && !csvNumSet.has(p.externalId))

  console.log(`\n计划：刷新 ${toUpdate.length} 条 / 新建 ${toCreate.length} 条 / 归档 ${toArchive.length} 条`)
  console.log('\n新建样例(前5)：')
  for (const r of toCreate.slice(0, 5)) console.log(`  [${r.num}] ${r.name} | €${r.lstPrice} | cost €${r.stdPrice}`)
  console.log('\n归档样例(前10)：')
  for (const p of toArchive.slice(0, 10)) console.log(`  [${p.externalId}] ${p.name}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(localProds, null, 2))
  console.log(`\n已备份当前 ${localProds.length} 条商品记录到 ${BACKUP_PATH}`)

  let updated = 0, created = 0, archived = 0
  for (const r of toUpdate) {
    const cur = localByNum.get(r.num)!
    const categoryId = r.categExt ? (catByExt.get(r.categExt) ?? null) : null
    const customerTaxRate = r.taxExt && r.taxExt in TAX_RATE_MAP ? TAX_RATE_MAP[r.taxExt] : undefined
    const data: Record<string, unknown> = {
      name: r.name,
      internalRef: r.defaultCode || undefined,
      listPrice: r.lstPrice,
      standardPrice: r.stdPrice,
      commissionPrice: r.commission,
      status: 'ACTIVE',
    }
    if (categoryId) data.categoryId = categoryId
    if (customerTaxRate !== undefined) data.customerTaxRate = customerTaxRate

    await prisma.product.update({ where: { id: cur.id }, data: data as never })
    await prisma.productTemplate.update({
      where: { id: cur.templateId },
      data: {
        name: r.name,
        internalRef: r.defaultCode || undefined,
        listPrice: r.lstPrice,
        standardPrice: r.stdPrice,
        weight: r.weight,
        commissionPrice: r.commission,
        status: 'ACTIVE',
        ...(categoryId ? { categoryId } : {}),
        ...(customerTaxRate !== undefined ? { customerTaxRate } : {}),
      } as never,
    })
    updated++
    if (updated % 100 === 0) console.log(`  ...刷新进度 ${updated}/${toUpdate.length}`)
  }

  for (const r of toCreate) {
    const categoryId = r.categExt ? (catByExt.get(r.categExt) ?? null) : null
    const customerTaxRate = r.taxExt && r.taxExt in TAX_RATE_MAP ? TAX_RATE_MAP[r.taxExt] : 0
    const tmpl = await prisma.productTemplate.create({
      data: {
        name: r.name,
        internalRef: r.defaultCode || undefined,
        listPrice: r.lstPrice,
        standardPrice: r.stdPrice,
        weight: r.weight,
        commissionPrice: r.commission,
        externalId: r.num,
        status: 'ACTIVE',
        categoryId: categoryId ?? undefined,
        customerTaxRate,
      },
    })
    await prisma.product.create({
      data: {
        templateId: tmpl.id,
        name: r.name,
        internalRef: r.defaultCode || undefined,
        listPrice: r.lstPrice,
        standardPrice: r.stdPrice,
        commissionPrice: r.commission,
        externalId: r.num,
        status: 'ACTIVE',
        categoryId: categoryId ?? undefined,
        customerTaxRate,
      },
    })
    created++
  }

  for (const p of toArchive) {
    await prisma.product.update({ where: { id: p.id }, data: { status: 'ARCHIVED' } })
    archived++
  }

  console.log(`\n✅ 完成：刷新 ${updated} / 新建 ${created} / 归档 ${archived}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
