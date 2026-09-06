/**
 * 只读诊断（续）：用 Odoo 原始导出 res_partner.csv（含真实 customer/supplier 布尔字段）
 * 逐条核实剩余两个未处理项，不再凭公司名猜：
 *   1. Cash Customer 的 isVendor=true 是否真的错标
 *   2. isCustomer=true && isVendor=false && 订单数=0 的 ~350 条里，Odoo 原始数据说它们
 *      到底是 customer/supplier/both/neither
 *
 *   npx tsx --env-file=.env.local scripts/diagnose-customer-vendor-mix-part2-20260905.ts
 */
import 'dotenv/config'
import fs from 'fs'
import path from 'path'
import { createPrismaClient } from '@/lib/prisma-factory'

const prisma = createPrismaClient()
const CSV_PATH = path.join(__dirname, 'odoo-migration/exports/res_partner.csv')

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

async function main() {
  const csvRows = parseCsv(fs.readFileSync(CSV_PATH, 'utf-8'))
  const byExt = new Map(csvRows.map(r => [r.external_id, r]))
  console.log(`Odoo 原始导出：${csvRows.length} 条`)

  const all = await prisma.customer.findMany({
    select: { id: true, name: true, isCustomer: true, isVendor: true, isActive: true, externalId: true },
  })

  // --- 1. Cash Customer ---
  const cash = all.filter(c => c.name.toLowerCase().includes('cash customer'))
  console.log(`\n=== Cash Customer 核实 ===`)
  for (const c of cash) {
    const csv = c.externalId ? byExt.get(c.externalId) : undefined
    console.log(`[${c.externalId}] ${c.name} isCustomer=${c.isCustomer} isVendor=${c.isVendor} | Odoo原始: ${csv ? `customer=${csv.customer} supplier=${csv.supplier} active=${csv.active}` : '未在导出中找到（可能已 inactive 或不在这 1478 条里）'}`)
  }

  // --- 2. isCustomer-only 零订单 350 条 ---
  const custOnly = all.filter(c => c.isCustomer && !c.isVendor)
  const custOnlyIds = custOnly.map(c => c.id)
  const orderCounts = await prisma.order.groupBy({ by: ['restaurantId'], where: { restaurantId: { in: custOnlyIds } }, _count: true })
  const orderM = new Map(orderCounts.map((r: any) => [r.restaurantId, r._count]))
  const zeroOrder = custOnly.filter(c => !orderM.get(c.id))
  console.log(`\n=== isCustomer=true && isVendor=false && 订单数=0：共 ${zeroOrder.length} 条 ===`)

  const buckets = {
    csvSaysSupplierOnly: [] as typeof zeroOrder, // Odoo 说是纯供应商，本系统标反了
    csvSaysBoth: [] as typeof zeroOrder,          // Odoo 说两者都是，本系统漏标 isVendor
    csvSaysCustomerOnly: [] as typeof zeroOrder,  // Odoo 也说是纯客户，标记正确，只是零订单(正常休眠)
    csvSaysNeither: [] as typeof zeroOrder,       // Odoo 说两者都不是（含内部账号等）
    notInCsv: [] as typeof zeroOrder,             // 不在 1478 条活跃导出里（已 inactive 或早已不存在）
  }
  for (const c of zeroOrder) {
    const csv = c.externalId ? byExt.get(c.externalId) : undefined
    if (!csv) { buckets.notInCsv.push(c); continue }
    const isCust = csv.customer === 't'
    const isSup = csv.supplier === 't'
    if (isSup && !isCust) buckets.csvSaysSupplierOnly.push(c)
    else if (isSup && isCust) buckets.csvSaysBoth.push(c)
    else if (!isSup && isCust) buckets.csvSaysCustomerOnly.push(c)
    else buckets.csvSaysNeither.push(c)
  }

  console.log(`\n  Odoo 说是「纯供应商」但本系统标成 isCustomer=true（真正误标，应改 isCustomer→false, isVendor→true）: ${buckets.csvSaysSupplierOnly.length}`)
  for (const c of buckets.csvSaysSupplierOnly) console.log(`    [${c.externalId}] ${c.name}`)

  console.log(`\n  Odoo 说「两者都是」但本系统漏标 isVendor（应补 isVendor→true，isCustomer 保留）: ${buckets.csvSaysBoth.length}`)
  for (const c of buckets.csvSaysBoth.slice(0, 30)) console.log(`    [${c.externalId}] ${c.name}`)
  if (buckets.csvSaysBoth.length > 30) console.log(`    ...共 ${buckets.csvSaysBoth.length} 条`)

  console.log(`\n  Odoo 也说是纯客户，标记正确，零订单是正常休眠（不动）: ${buckets.csvSaysCustomerOnly.length}`)

  console.log(`\n  Odoo 说两者都不是（既非 customer 也非 supplier，属性异常，需要人工看是什么类型的记录）: ${buckets.csvSaysNeither.length}`)
  for (const c of buckets.csvSaysNeither) console.log(`    [${c.externalId}] ${c.name}`)

  console.log(`\n  不在 1478 条活跃导出里（Odoo 里已 inactive 或本地记录更老，导出覆盖不到）: ${buckets.notInCsv.length}`)
  console.log(`    （抽样前 10 条）`)
  for (const c of buckets.notInCsv.slice(0, 10)) console.log(`    [${c.externalId ?? '无externalId'}] ${c.name}`)
}

main()
  .catch((e) => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
