/**
 * scripts/import-odoo-missing-customers-for-orders-20260717.ts
 *
 * Phase 4 前置步骤：补齐历史订单会引用、但 Phase 3b（import-odoo-customers-20260717.ts，
 * 仅导入 active='t' 的 res_partner）没覆盖到的 55 个客户/供应商。
 *
 * 这 55 个 externalId 是这样定位的：对比 sale_order.partner_id 全集与已导入 Customer.externalId
 * 全集，差集共 55 个，其中 54 个在 Odoo 里 active='f'（历史客户，早已停用但仍有历史订单需要
 * 挂靠），1 个是 Odoo 内置的 "Public user"（id=4，customer=false/supplier=false，涉及 15 笔
 * 历史订单，同样是真实数据不是发明数据）。
 *
 * 来源：scripts/odoo-migration/exports/res_partner_missing_for_orders.csv
 * （对 res_partner 按上述 55 个 id 直接查询导出，不受 active/customer/supplier 过滤）
 *
 * 全部为新建（这 55 个 externalId 在生产库里必然不存在，脚本仍按 externalId 判重防止重跑重复插入）。
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-odoo-missing-customers-for-orders-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-odoo-missing-customers-for-orders-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const CSV_PATHS = [
  path.join(__dirname, 'odoo-migration/exports/res_partner_missing_for_orders.csv'),
  // 第一批人工转录 externalId 列表时遗漏了 15 个（794/892/865 等，700-999 号段），
  // 用脚本直接从 DB 反查缺口后补的第二批，教训：以后一律用脚本写文件传递 id 列表，不手工转录。
  path.join(__dirname, 'odoo-migration/exports/res_partner_missing_for_orders2.csv'),
]

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
  const rows = CSV_PATHS.flatMap(p => parseCsv(fs.readFileSync(p, 'utf-8')))
  console.log(`CSV 解析：${rows.length} 条待补齐客户`)

  const existing = await prisma.customer.findMany({ select: { externalId: true } })
  const existingExt = new Set(existing.filter(c => c.externalId).map(c => c.externalId as string))
  const toCreate = rows.filter(r => !existingExt.has(r.external_id))

  console.log(`计划：新建 ${toCreate.length}（跳过 ${rows.length - toCreate.length} 个已存在）`)
  for (const r of toCreate) console.log(`  [${r.external_id}] ${r.name} | customer=${r.customer} supplier=${r.supplier}`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  let created = 0
  for (const r of toCreate) {
    await prisma.customer.create({
      data: {
        name: r.name || `(Odoo #${r.external_id})`,
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
      },
    })
    created++
  }
  console.log(`\n✅ 完成：新建 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
