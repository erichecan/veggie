/**
 * scripts/import-odoo-vendors-20260714.ts
 *
 * 一次性数据刷新：用 Odoo(m.johnstonebros.ie) 导出的 Vendors 列表(res.partner (1).csv，
 * 192 条，Vendor 筛选)覆盖本系统 Customer(isVendor=true) 记录的基础信息字段，效果等同于
 * "清空重导"，但不物理删除任何 Customer 行——因为删除会级联炸掉 ProductSupplierInfo(供应商-
 * 商品价格/交期，当时约 600 条)，且历史 PurchaseOrder/VendorBill/PurchaseRecord/
 * PurchaseSuggestion 的 supplierId 只是纯字符串(无 DB 外键)，记录一删这些历史单据的供应商
 * 名字会显示成乱码 cuid(用户已确认改用"原地覆盖+归档"方案，2026-07-14)。
 *
 * 匹配规则：
 *   - CSV "ID" 列 = Odoo res.partner 数据库主键(纯数字字符串，如 "1697") → Customer.externalId
 *     (系统现存 191 条供应商记录的 externalId 本来就是这个格式，不是 XML External ID)
 *   - 匹配到 → 原地覆盖 name/vatNumber/street/street2/city/state/zip/country/phone/email/
 *     supplierPaymentTerm(+ 派生 address，逻辑与 app/api/customers/[id]/route.ts 保持一致)，
 *     同时把 isVendor/isActive 都设为 true(可能之前被归档过，Odoo 里又出现了要恢复)
 *   - CSV 有但系统没有 → 新增 Customer(isVendor=true, isCustomer=false)
 *   - 系统 isVendor=true 且 isActive=true 但 CSV 里没有 → 归档(isActive=false)，不物理删除
 *   - vendorTaxRate/creditLimit/commissionRate/commissionFixed/salesUserId/pricelistId/
 *     priceType/defaultDriverSlotId 等 Odoo 导出里没有对应字段的，一律不碰(不拿空值覆盖，
 *     避免"没有 Odoo 数据来源却把值抹掉")
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-vendors-20260714.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-vendors-20260714.ts dotenv_config_path=.env.local --apply    # 实际写入(会先备份)
 *
 * 回滚：--apply 前会把当前全部 isVendor=true 记录整表快照写到
 *   scripts/.backup-vendors-pre-20260714.json，需要回滚时按 externalId 手工核对该文件即可。
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
const CSV_PATH = '/Users/eric/Downloads/res.partner (1).csv'
const BACKUP_PATH = path.join(__dirname, '.backup-vendors-pre-20260714.json')

// Odoo base 模块国家 XML ID → 与本系统 Customer.country 既有习惯一致的英文全称
const COUNTRY_MAP: Record<string, string> = {
  ie: 'Ireland',
  nl: 'Netherlands',
  es: 'Spain',
  uk: 'United Kingdom',
  it: 'Italy',
  de: 'Germany',
  dk: 'Denmark',
  af: 'Afghanistan',
  cn: 'China',
}

function parseCSVLine(line: string): string[] {
  const out: string[] = []
  let cur = ''
  let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q
    } else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur)
  return out
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

function mapCountry(raw: string): string {
  const v = raw.trim()
  if (!v) return ''
  const m = v.match(/^base\.([a-z]{2})$/i)
  if (m) return COUNTRY_MAP[m[1].toLowerCase()] ?? v
  return v
}

function deriveAddress(f: { street: string; street2: string; city: string; state: string; zip: string; country: string }): string {
  return [f.street, f.street2, f.city, f.state, f.zip, f.country].map(s => s.trim()).filter(Boolean).join(', ')
}

interface VendorRow {
  externalId: string
  name: string
  vatNumber: string
  street: string
  street2: string
  city: string
  state: string
  zip: string
  country: string
  phone: string
  email: string
  supplierPaymentTerm: string
}

async function main() {
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/\r\n/g, '\n')
  const rows = parseCSVRows(raw)
  const header = rows[0]
  const col = (name: string) => {
    const i = header.indexOf(name)
    if (i === -1) throw new Error(`CSV 缺少列: ${name}`)
    return i
  }
  const idx = {
    id: col('ID'),
    name: col('Name'),
    vat: col('Tax ID'),
    street: col('Street'),
    street2: col('Street2'),
    city: col('City'),
    state: col('State'),
    zip: col('Zip'),
    country: col('Country'),
    phone: col('Phone'),
    mobile: col('Mobile'),
    email: col('Email'),
    paymentTerm: col('Vendor Payment Terms'),
  }

  const vendorRows: VendorRow[] = []
  for (const r of rows.slice(1)) {
    const id = (r[idx.id] ?? '').trim()
    const name = (r[idx.name] ?? '').trim()
    if (!id || !name) continue // 不臆造数据：缺 ID 或缺名字的行跳过
    vendorRows.push({
      externalId: id,
      name,
      vatNumber: (r[idx.vat] ?? '').trim(),
      street: (r[idx.street] ?? '').trim(),
      street2: (r[idx.street2] ?? '').trim(),
      city: (r[idx.city] ?? '').trim(),
      state: (r[idx.state] ?? '').trim(),
      zip: (r[idx.zip] ?? '').trim(),
      country: mapCountry(r[idx.country] ?? ''),
      phone: (r[idx.phone] ?? '').trim() || (r[idx.mobile] ?? '').trim(),
      email: (r[idx.email] ?? '').trim(),
      supplierPaymentTerm: (r[idx.paymentTerm] ?? '').trim(),
    })
  }
  console.log(`CSV 解析：${vendorRows.length} 条有效供应商行（原始 ${rows.length - 1} 行）`)

  const existing = await prisma.customer.findMany({
    where: { isVendor: true },
    select: { id: true, name: true, externalId: true, isActive: true },
  })
  // 匹配范围放宽到全表(不止 isVendor=true)：否则像 TFJ Butchers LTD 这种"Odoo 里是
  // vendor，本系统里早已存在但只是 isCustomer=true"的记录，会被误判成"不存在"而重复新建
  // (2026-07-14 --apply 中途因事务超时中断后诊断发现的边界情况)
  const allByExt = await prisma.customer.findMany({
    where: { externalId: { not: null } },
    select: { id: true, name: true, externalId: true, isActive: true, isVendor: true },
  })
  const existingByExt = new Map(allByExt.map(c => [c.externalId as string, c]))
  console.log(`系统现有 isVendor=true 记录：${existing.length} 条；全表按 externalId 可匹配：${existingByExt.size} 条`)

  const csvIdSet = new Set(vendorRows.map(v => v.externalId))
  const toUpdate = vendorRows.filter(v => existingByExt.has(v.externalId))
  const toCreate = vendorRows.filter(v => !existingByExt.has(v.externalId))
  const toArchive = existing.filter(c => c.isActive && c.externalId && !csvIdSet.has(c.externalId))

  console.log(`\n计划：更新 ${toUpdate.length} 条 / 新增 ${toCreate.length} 条 / 归档 ${toArchive.length} 条`)
  console.log('\n更新样例(前3条)：')
  for (const v of toUpdate.slice(0, 3)) {
    console.log(`  [${v.externalId}] ${existingByExt.get(v.externalId)!.name} → ${v.name} | ${deriveAddress(v)} | VAT=${v.vatNumber || '—'}`)
  }
  console.log('\n新增样例(前3条)：')
  for (const v of toCreate.slice(0, 3)) {
    console.log(`  [${v.externalId}] ${v.name} | ${deriveAddress(v)} | VAT=${v.vatNumber || '—'}`)
  }
  console.log('\n归档样例(前5条)：')
  for (const c of toArchive.slice(0, 5)) {
    console.log(`  [${c.externalId}] ${c.name}`)
  }

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  fs.writeFileSync(BACKUP_PATH, JSON.stringify(existing, null, 2))
  console.log(`\n已备份当前 ${existing.length} 条供应商记录到 ${BACKUP_PATH}`)

  // 不用 $transaction 包裹：2026-07-14 首次 --apply 已经实测证明，Neon 适配器下交互式事务
  // 超时(哪怕手动调大 timeout)并不保证整体回滚——超时报错抛出前，前面已执行的 update 早已
  // 落库(191 条里 185 条已生效)。与其继续依赖一个实际不生效的原子性假象，不如老实做逐条顺序
  // 写入：每条更新都是同值幂等覆盖，中途真断了，直接重跑本脚本即可从断点续上，无副作用。
  let updated = 0, created = 0, archived = 0
  for (const v of toUpdate) {
    const cur = existingByExt.get(v.externalId)!
    await prisma.customer.update({
      where: { id: cur.id },
      data: {
        name: v.name,
        vatNumber: v.vatNumber,
        street: v.street,
        street2: v.street2,
        city: v.city,
        state: v.state,
        zip: v.zip,
        country: v.country,
        phone: v.phone,
        email: v.email,
        supplierPaymentTerm: v.supplierPaymentTerm,
        address: deriveAddress(v),
        latitude: null,
        longitude: null,
        isVendor: true,
        isActive: true,
      },
    })
    updated++
    if (updated % 50 === 0) console.log(`  ...更新进度 ${updated}/${toUpdate.length}`)
  }
  for (const v of toCreate) {
    await prisma.customer.create({
      data: {
        name: v.name,
        vatNumber: v.vatNumber,
        street: v.street,
        street2: v.street2,
        city: v.city,
        state: v.state,
        zip: v.zip,
        country: v.country,
        phone: v.phone,
        email: v.email,
        supplierPaymentTerm: v.supplierPaymentTerm,
        address: deriveAddress(v),
        externalId: v.externalId,
        isVendor: true,
        isCustomer: false,
        isActive: true,
      },
    })
    created++
  }
  for (const c of toArchive) {
    await prisma.customer.update({ where: { id: c.id }, data: { isActive: false } })
    archived++
  }

  console.log(`\n✅ 完成：更新 ${updated} / 新增 ${created} / 归档 ${archived}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
