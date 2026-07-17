/**
 * scripts/backfill-odoo-orderlines-20260717.ts
 *
 * 修复 import-odoo-orders-full-20260717.ts 的一个 bug：该脚本把 lines 分组 Map 的 key
 * 用了 CSV 原始 order_external_id（Odoo 数字 id），但按订单 externalRef（写入时已改成
 * `sale_order_<num>_import20260717` 格式）去查，两者对不上，导致 149,013 笔新订单全部
 * 建成后行明细是空的（createMany 0 行，脚本日志"新建行明细 0"）。
 *
 * 本脚本只做行明细补录，不再碰 Order 表（订单本身已经正确建好，只是缺 OrderLine）：
 *   - 只处理 externalRef LIKE '%_import20260717' 的订单（即上次那批新建的 149,013 笔）
 *   - 按 externalRef 里嵌的 Odoo 数字 id 反查 sale_order_line.csv 对应行
 *   - 写入前用 orderId 查一次已有 OrderLine 数量，非 0 则跳过（防止本脚本本身重跑重复插入）
 *
 * 运行：
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/backfill-odoo-orderlines-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/backfill-odoo-orderlines-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import fs from 'fs'
import path from 'path'
import readline from 'readline'
import { PrismaClient } from '../lib/generated/prisma/client'
import { PrismaNeon } from '@prisma/adapter-neon'
import { neonConfig } from '@neondatabase/serverless'
import ws from 'ws'

neonConfig.webSocketConstructor = ws
const prisma = new PrismaClient({ adapter: new PrismaNeon({ connectionString: process.env.DATABASE_URL! }) })

const APPLY = process.argv.includes('--apply')
const LINE_CSV = path.join(__dirname, 'odoo-migration/exports/sale_order_line.csv')
const ORDER_CHUNK = 1000
const LINE_CHUNK = 2000

function parseCSVLine(line: string): string[] {
  const out: string[] = []; let cur = ''; let q = false
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') { if (q && line[i + 1] === '"') { cur += '"'; i++ } else q = !q }
    else if (ch === ',' && !q) { out.push(cur); cur = '' } else cur += ch
  }
  out.push(cur); return out
}

async function streamCsv(filePath: string, onRow: (row: Record<string, string>) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
  let headers: string[] | null = null
  let buf = ''
  for await (const pl of rl) {
    buf = buf ? buf + '\n' + pl : pl
    const quoteCount = (buf.match(/"/g) ?? []).length
    if (quoteCount % 2 !== 0) continue
    if (buf.trim().length === 0) { buf = ''; continue }
    const vals = parseCSVLine(buf)
    buf = ''
    if (!headers) { headers = vals; continue }
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    onRow(row)
  }
}

const toNum = (s: string, d = 0) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d }
const round2 = (n: number) => Math.round(n * 100) / 100

function extractOrderNumId(externalRef: string): string | null {
  const m = externalRef.match(/sale_order_(\d+)_/)
  return m ? m[1] : null
}

async function main() {
  console.log('=== 加载待补行的订单（externalRef 带 _import20260717 后缀）===')
  const orders = await prisma.order.findMany({
    where: { externalRef: { endsWith: '_import20260717' } },
    select: { id: true, externalRef: true },
  })
  console.log(`共 ${orders.length} 笔`)

  const numIdToOrderId = new Map<string, string>()
  for (const o of orders) {
    const n = extractOrderNumId(o.externalRef as string)
    if (n) numIdToOrderId.set(n, o.id)
  }
  console.log(`成功解析数字 id: ${numIdToOrderId.size} 笔`)

  console.log('\n=== 确认这批订单当前是否已有行明细（应为 0，防止重复插入）===')
  // 149,013 个 id 放进单条 IN 子句会撑爆 Prisma 查询渲染的调用栈，改用 join 子查询。
  const existingLineCountResult = await prisma.$queryRaw<{ count: bigint }[]>`
    SELECT count(*)::bigint AS count FROM "OrderLine" ol
    JOIN "Order" o ON o.id = ol."orderId"
    WHERE o."externalRef" LIKE '%_import20260717'
  `
  const existingLineCount = Number(existingLineCountResult[0].count)
  console.log(`已有行明细: ${existingLineCount} 条`)
  if (existingLineCount > 0) {
    console.log('⚠️ 这批订单已经有部分/全部行明细了，为避免重复插入，脚本终止。请人工核查后再决定如何处理。')
    await prisma.$disconnect()
    return
  }

  const products = await prisma.product.findMany({ select: { id: true, externalId: true } })
  const prodByExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p.id]))
  console.log(`Product: ${prodByExt.size} 条`)

  console.log('\n=== 流式解析 sale_order_line.csv，按 order_external_id 分组 ===')
  const linesByOrderExt = new Map<string, Record<string, string>[]>()
  let lineRowCount = 0
  await streamCsv(LINE_CSV, row => {
    if (!numIdToOrderId.has(row.order_external_id)) return // 只保留这批订单相关的行，省内存
    lineRowCount++
    let arr = linesByOrderExt.get(row.order_external_id)
    if (!arr) { arr = []; linesByOrderExt.set(row.order_external_id, arr) }
    arr.push(row)
  })
  console.log(`相关行明细共 ${lineRowCount} 条，覆盖 ${linesByOrderExt.size} 个订单`)

  let totalLineCreates = 0
  let productMissing = 0
  const allNumIds = [...numIdToOrderId.keys()]
  for (let i = 0; i < allNumIds.length; i += ORDER_CHUNK) {
    const chunkNumIds = allNumIds.slice(i, i + ORDER_CHUNK)
    for (const numId of chunkNumIds) {
      const orderId = numIdToOrderId.get(numId)!
      const lines = linesByOrderExt.get(numId) ?? []
      for (const l of lines) {
        const productId = prodByExt.get(l.product_external_id)
        if (!productId) { productMissing++; continue }
        totalLineCreates++
      }
    }
  }
  console.log(`\n计划新建行明细: ${totalLineCreates} 条`)
  if (productMissing > 0) console.log(`⚠️ ${productMissing} 行因商品未匹配将被跳过`)

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    await prisma.$disconnect()
    return
  }

  console.log('\n=== 开始写入 ===')
  let created = 0
  for (let i = 0; i < allNumIds.length; i += ORDER_CHUNK) {
    const chunkNumIds = allNumIds.slice(i, i + ORDER_CHUNK)
    const lineCreates: {
      orderId: string; productId: string; productName: string; uomName?: string
      unitPrice: number; orderedQty: number; deliveredQty: number; invoicedQty: number
      subtotal: number; sequence: number
    }[] = []
    for (const numId of chunkNumIds) {
      const orderId = numIdToOrderId.get(numId)!
      const lines = linesByOrderExt.get(numId) ?? []
      for (const l of lines) {
        const productId = prodByExt.get(l.product_external_id)
        if (!productId) continue
        const unitPrice = round2(toNum(l.price_unit))
        const orderedQty = toNum(l.product_uom_qty)
        lineCreates.push({
          orderId,
          productId,
          productName: l.name || '(未命名商品)',
          uomName: l.uom_name || undefined,
          unitPrice,
          orderedQty,
          deliveredQty: toNum(l.qty_delivered),
          invoicedQty: toNum(l.qty_invoiced),
          subtotal: round2(unitPrice * orderedQty),
          sequence: Math.trunc(toNum(l.sequence)),
        })
      }
    }
    for (let j = 0; j < lineCreates.length; j += LINE_CHUNK) {
      await prisma.orderLine.createMany({ data: lineCreates.slice(j, j + LINE_CHUNK) })
    }
    created += lineCreates.length
    console.log(`  ...进度 订单 ${Math.min(i + ORDER_CHUNK, allNumIds.length)}/${allNumIds.length}，行 ${created}`)
  }

  console.log(`\n✅ 完成：新建行明细 ${created}`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
