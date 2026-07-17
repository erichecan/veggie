/**
 * scripts/import-odoo-customers-20260717.ts
 *
 * 全量数据迁移 Phase 3b：从本地 Odoo 镜像库导出的 res_partner（customer=true OR
 * supplier=true 且 active=true，共 1478 条，含国家/州/付款条款人类可读名称的 join 结果，
 * 见 scripts/odoo-migration/exports/res_partner.csv）同步 Customer。
 *
 * 沿用 2026-07-14 供应商同步（scripts/import-odoo-vendors-20260714.ts）确立的模式：
 * 原地覆盖 + 不物理删除，只是这次源数据是全量 res_partner（含客户+供应商），不再局限于
 * CSV 只包含 192 条 vendor 的那份。
 *
 * 与生产库比对（20260717）：Odoo 活跃客户/供应商 1478 条，已匹配 1472 条，仅 6 条全新；
 * 另有 40 条生产库有 externalId 但这份 Odoo 导出里找不到（4 条在 Odoo 里已 inactive，
 * 36 条完全不在这份库里，含少量非数字 XML External ID 格式的历史遗留记录）——这 40 条
 * 本次不做任何归档处理，只是不覆盖，留给运营后续人工判断。
 *
 * 匹配规则：
 *   - external_id（Odoo res_partner 数字主键）→ Customer.externalId（已于 Phase 2 加 @unique）
 *   - 匹配到 → 原地覆盖 name/vatNumber/street/street2/city/state/zip/country/phone/email/
 *     isCustomer/isVendor（按 Odoo 的 customer/supplier 布尔字段回填，不缩小已有权限——
 *     即本地已是 true 的不会被 Odoo 的 false 覆盖回 false，只做"补充"不做"收窄"）
 *   - Odoo 有、本地没有 → 新建
 *   - vendorTaxRate/creditLimit/commissionRate/commissionFixed/salesUserId/priceType 等
 *     Odoo 导出没有对应字段的，一律不碰
 *   - payment term：customer→paymentTerm，supplier→supplierPaymentTerm，仅在 Odoo 有值时覆盖
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-customers-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-customers-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 *
 * 回滚：--apply 前会把当前全部 Customer 整表快照写到
 *   scripts/.backup-customers-pre-20260717.json
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
const CSV_PATH = path.join(__dirname, 'odoo-migration/exports/res_partner.csv')
const BACKUP_PATH = path.join(__dirname, '.backup-customers-pre-20260717.json')

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

function deriveAddress(f: { street: string; street2: string; city: string; state: string; zip: string; country: string }): string {
  return [f.street, f.street2, f.city, f.state, f.zip, f.country].map(s => s.trim()).filter(Boolean).join(', ')
}

async function main() {
  const allRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'))
  // 排除 Odoo 系统内置的 Public user(id=4)，不是真实业务伙伴；只要 active=true
  const rows = allRows.filter(r => r.active === 't' && r.external_id !== '4')
  console.log(`CSV 解析：${rows.length} 条有效客户/供应商行（原始 ${allRows.length} 行）`)

  const existing = await prisma.customer.findMany({
    select: { id: true, name: true, externalId: true, isCustomer: true, isVendor: true },
  })
  const byExt = new Map(existing.filter(c => c.externalId).map(c => [c.externalId as string, c]))

  const toUpdate = rows.filter(r => byExt.has(r.external_id))
  const toCreate = rows.filter(r => !byExt.has(r.external_id))

  console.log(`\n计划：更新 ${toUpdate.length} / 新建 ${toCreate.length}`)
  console.log('新建列表：')
  for (const r of toCreate) console.log(`  [${r.external_id}] ${r.name} | customer=${r.customer} supplier=${r.supplier}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(existing, null, 2))
  console.log(`\n已备份当前 ${existing.length} 条客户记录到 ${BACKUP_PATH}`)

  // 不用 $transaction：沿用 20260714 供应商同步的实测教训（Neon 适配器下交互式事务超时
  // 不保证整体回滚，逐条顺序写入即可安全断点续跑）。
  let updated = 0, created = 0
  for (const r of toUpdate) {
    const cur = byExt.get(r.external_id)!
    const data: Record<string, unknown> = {
      name: r.name,
      vatNumber: r.vat,
      street: r.street,
      street2: r.street2,
      city: r.city,
      state: r.state_name,
      zip: r.zip,
      country: r.country_name,
      phone: r.phone || r.mobile,
      email: r.email,
      address: deriveAddress({ street: r.street, street2: r.street2, city: r.city, state: r.state_name, zip: r.zip, country: r.country_name }),
      // 只补充不收窄：本地已是 true 的不被 Odoo 的 false 覆盖回 false
      isCustomer: cur.isCustomer || r.customer === 't',
      isVendor: cur.isVendor || r.supplier === 't',
    }
    if (r.payment_term_customer) data.paymentTerm = r.payment_term_customer
    if (r.payment_term_supplier) data.supplierPaymentTerm = r.payment_term_supplier
    await prisma.customer.update({ where: { id: cur.id }, data: data as never })
    updated++
    if (updated % 100 === 0) console.log(`  ...更新进度 ${updated}/${toUpdate.length}`)
  }
  for (const r of toCreate) {
    await prisma.customer.create({
      data: {
        name: r.name,
        externalId: r.external_id,
        vatNumber: r.vat,
        street: r.street,
        street2: r.street2,
        city: r.city,
        state: r.state_name,
        zip: r.zip,
        country: r.country_name,
        phone: r.phone || r.mobile,
        email: r.email,
        address: deriveAddress({ street: r.street, street2: r.street2, city: r.city, state: r.state_name, zip: r.zip, country: r.country_name }),
        isCustomer: r.customer === 't',
        isVendor: r.supplier === 't',
        ...(r.payment_term_customer ? { paymentTerm: r.payment_term_customer } : {}),
        ...(r.payment_term_supplier ? { supplierPaymentTerm: r.payment_term_supplier } : {}),
      },
    })
    created++
  }
  console.log(`\n✅ 完成：更新 ${updated} / 新建 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
