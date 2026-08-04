/**
 * scripts/import-odoo-invoices-20260718.ts
 *
 * 全量数据迁移补录：从本地 Odoo 镜像库（odoo_restore）导出的 account_invoice（153,260 条，
 * 已按 type/number/origin 过滤为 149,542 条有效客户单据）+ account_invoice_line（1,320,181 行）
 * 导入 Invoice / CreditNote，补齐订单已导入但发票号一直缺失的问题（07-17 全量订单迁移当时
 * 没有导出发票表，见 docs/20260717-odoo-single-source-migration-plan.md 第三节）。
 *
 * 数据源与筛选（导出时已在 SQL 里过滤，见 scripts/odoo-migration/exports/*.csv 的生成命令）：
 *   - type IN ('out_invoice', 'out_refund')：只要客户单据，供应商发票/退款（in_invoice/in_refund，
 *     18 条）不在此次范围
 *   - number IS NOT NULL：跳过草稿态未定稿、还没有正式发票号的记录
 *   - origin IS NOT NULL AND <> ''：跳过无法关联回任何订单的 115 条孤儿发票
 *
 * 类型映射：
 *   - type=out_invoice → Invoice（客户发票）
 *   - type=out_refund  → CreditNote（贷记单/退款单，schema 里已有专门模型）
 *
 * 关键难点：account_invoice.origin 存的是 Odoo 订单编号（如 "D152099"，可能逗号分隔多个，
 * 代表一票多单合并开票），但本项目 Order.externalRef 存的是 Odoo sale_order.id 数字 id
 * （形如 "sale_order_152113_import20260717" 或历史遗留的 "__export__.sale_order_152113_<hash>"），
 * 两者不能直接比较。关联路径：
 *   origin(如 "D152099") --查 sale_order_id_name.csv--> sale_order.id(如 152113)
 *                          --正则匹配 Order.externalRef 里的数字部分--> 本系统 Order.id
 *
 * 发票行归属：account_invoice_line 每一行自带自己的 origin（始终是单个订单号，不会逗号
 * 拼接——已用 SQL 验证 0 条例外），按此字段分组即可精确还原"一票多单"时每张订单在这张
 * 发票里各自的金额，用于拼 Invoice.lines 的 Json 明细。
 *
 * 幂等：Invoice.name / CreditNote.name 均有 @@unique(name)，按发票号/贷记单号判重，
 * 断点续跑安全。
 *
 * 运行：
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-invoices-20260718.ts dotenv_config_path=.env.local            # dry-run
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-invoices-20260718.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const INVOICE_CSV = path.join(__dirname, 'odoo-migration/exports/account_invoice.csv')
const LINE_CSV = path.join(__dirname, 'odoo-migration/exports/account_invoice_line.csv')
const ORDER_NAME_CSV = path.join(__dirname, 'odoo-migration/exports/sale_order_id_name.csv')
const BATCH = 500
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
const toDateStr = (s: string): string | undefined => (s && s.trim() ? s.trim().slice(0, 10) : undefined)
const toDateTime = (s: string): Date | undefined => (s && s.trim() ? new Date(s.trim() + 'Z') : undefined)

function mapInvoiceStatus(state: string): 'DRAFT' | 'POSTED' | 'PAID' | 'CANCELLED' {
  if (state === 'paid') return 'PAID'
  if (state === 'open') return 'POSTED'
  if (state === 'cancel') return 'CANCELLED'
  return 'DRAFT'
}

function mapCreditNoteStatus(state: string): string {
  if (state === 'paid') return 'APPLIED'
  if (state === 'open') return 'CONFIRMED'
  if (state === 'cancel') return 'CANCELLED'
  return 'DRAFT'
}

/** 复用 07-17 订单迁移脚本同一套正则：不论 externalRef 是哪种历史前缀
 * （__export__.sale_order_<num>_<hash> / test-import-2026-07-14:... / sale_order_<num>_import20260717），
 * 都能提取出 Odoo sale_order.id 数字部分。 */
function extractOrderNumId(externalRef: string): string | null {
  const m = externalRef.match(/sale_order_(\d+)_/)
  return m ? m[1] : null
}

async function main() {
  console.log('=== 加载映射表 ===')

  const orderNameToId = new Map<string, string>() // "D152099" -> "152113"（Odoo sale_order.id）
  await streamCsv(ORDER_NAME_CSV, row => { if (row.name) orderNameToId.set(row.name, row.id) })
  console.log(`sale_order name→id 映射: ${orderNameToId.size} 条`)

  const orders = await prisma.order.findMany({
    where: { externalRef: { not: null } },
    select: { id: true, externalRef: true, restaurantId: true, restaurantName: true },
  })
  const odooIdToOrder = new Map<string, { id: string; restaurantId: string; restaurantName: string }>()
  for (const o of orders) {
    const numId = extractOrderNumId(o.externalRef as string)
    if (numId) odooIdToOrder.set(numId, { id: o.id, restaurantId: o.restaurantId, restaurantName: o.restaurantName })
  }
  console.log(`本系统 Order（按 Odoo 数字 id 索引）: ${odooIdToOrder.size} 条\n`)

  const products = await prisma.product.findMany({ select: { id: true, externalId: true } })
  const prodByExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p.id]))
  console.log(`Product: ${prodByExt.size} 条`)

  const existingInvoiceNames = new Set((await prisma.invoice.findMany({ select: { name: true } })).map(i => i.name))
  const existingCreditNoteNames = new Set((await prisma.creditNote.findMany({ select: { name: true } })).map(c => c.name))
  console.log(`生产库已有 Invoice: ${existingInvoiceNames.size} 条 / CreditNote: ${existingCreditNoteNames.size} 条\n`)

  console.log('=== 解析 account_invoice.csv ===')
  const invoiceRows: Record<string, string>[] = []
  await streamCsv(INVOICE_CSV, row => invoiceRows.push(row))
  console.log(`共 ${invoiceRows.length} 条发票/贷记单`)

  /** 把 origin 拆分成订单号列表，逐个解析到本系统 Order；解析不到的记一笔，不阻断整张发票。 */
  function resolveOrigins(origin: string) {
    const codes = origin.split(',').map(s => s.trim()).filter(Boolean)
    const resolved: { code: string; order: { id: string; restaurantId: string; restaurantName: string } }[] = []
    let unresolved = 0
    for (const code of codes) {
      const odooId = orderNameToId.get(code)
      const order = odooId ? odooIdToOrder.get(odooId) : undefined
      if (order) resolved.push({ code, order })
      else unresolved++
    }
    return { resolved, unresolved }
  }

  let skippedNoOrderMatch = 0
  let partialMatch = 0
  const statusCounts: Record<string, number> = {}
  type Resolved = {
    row: Record<string, string>
    kind: 'invoice' | 'creditnote'
    resolvedOrders: { code: string; order: { id: string; restaurantId: string; restaurantName: string } }[]
  }
  const toImport: Resolved[] = []

  for (const row of invoiceRows) {
    const kind = row.type === 'out_refund' ? 'creditnote' : 'invoice'
    if (kind === 'invoice' && existingInvoiceNames.has(row.number)) continue
    if (kind === 'creditnote' && existingCreditNoteNames.has(row.number)) continue

    const { resolved, unresolved } = resolveOrigins(row.origin)
    if (resolved.length === 0) { skippedNoOrderMatch++; continue }
    if (unresolved > 0) partialMatch++

    statusCounts[kind] = (statusCounts[kind] ?? 0) + 1
    toImport.push({ row, kind, resolvedOrders: resolved })
  }

  console.log('=== 统计 ===')
  console.log('待导入类型分布:', statusCounts)
  console.log(`跳过（origin 里没有一个订单能匹配上，理论应接近 0）: ${skippedNoOrderMatch}`)
  console.log(`部分匹配（一票多单，其中至少一单未匹配上，仍按能匹配的部分导入）: ${partialMatch}`)
  console.log(`待导入合计: ${toImport.length}\n`)

  if (!APPLY) {
    console.log('(dry-run，未写入。加 --apply 才会真正执行)')
    for (const r of toImport.slice(0, 3)) {
      console.log(' ', JSON.stringify({ number: r.row.number, kind: r.kind, orders: r.resolvedOrders.map(o => o.code) }))
    }
    return
  }

  console.log('=== 加载 account_invoice_line.csv 并按 invoice_id 分组 ===')
  const linesByInvoiceId = new Map<string, Record<string, string>[]>()
  let lineRowCount = 0
  await streamCsv(LINE_CSV, row => {
    lineRowCount++
    let arr = linesByInvoiceId.get(row.invoice_id)
    if (!arr) { arr = []; linesByInvoiceId.set(row.invoice_id, arr) }
    arr.push(row)
  })
  console.log(`发票行共 ${lineRowCount} 条，覆盖 ${linesByInvoiceId.size} 张发票\n`)

  console.log(`=== 开始批量写入（${toImport.length} 条，每批 ${BATCH}）===`)
  let invoicesCreated = 0
  let creditNotesCreated = 0
  let creditNoteLinesCreated = 0
  let lineProductMissing = 0

  const invoiceBatch = toImport.filter(r => r.kind === 'invoice')
  const creditNoteBatch = toImport.filter(r => r.kind === 'creditnote')

  /** 按 account_invoice_line.origin 分组求每张订单在这张(可能一票多单)发票里的金额，
   * 直接拼进 createMany 的 data 里，避免"先插入再逐条 update"这种 N 次往返（15 万条会很慢）。 */
  function buildLinesJson(r: Resolved) {
    const lineRows = linesByInvoiceId.get(r.row.id) ?? []
    const amountByCode = new Map<string, number>()
    for (const l of lineRows) amountByCode.set(l.origin, (amountByCode.get(l.origin) ?? 0) + toNum(l.price_subtotal))
    return r.resolvedOrders.map(o => ({
      amount: round2(amountByCode.get(o.code) ?? 0),
      orderId: o.order.id,
      orderCode: o.code,
    }))
  }

  // --- Invoice ---
  for (let i = 0; i < invoiceBatch.length; i += BATCH) {
    const batch = invoiceBatch.slice(i, i + BATCH)
    await prisma.invoice.createMany({
      data: batch.map(r => {
        const row = r.row
        const primary = r.resolvedOrders[0].order
        const amountTotal = toNum(row.amount_total)
        const residual = toNum(row.residual)
        return {
          name: row.number,
          customerId: primary.restaurantId,
          customerName: primary.restaurantName,
          saleOrderIds: r.resolvedOrders.map(o => o.order.id),
          lines: buildLinesJson(r),
          subtotalExTax: round2(toNum(row.amount_untaxed)),
          totalTax: round2(toNum(row.amount_tax)),
          totalIncTax: round2(amountTotal),
          amountPaid: round2(amountTotal - residual),
          amountDue: round2(residual),
          status: mapInvoiceStatus(row.state),
          dueDate: toDateStr(row.date_due),
          createdAt: toDateTime(row.create_date) ?? new Date(),
          postedAt: row.state !== 'draft' ? toDateStr(row.date_invoice) : undefined,
          paidAt: row.state === 'paid' ? toDateStr(row.date_invoice) : undefined,
        }
      }),
      skipDuplicates: true,
    })
    invoicesCreated += batch.length

    if (invoicesCreated % 5000 < BATCH) console.log(`  ...Invoice 进度 ${invoicesCreated}/${invoiceBatch.length}`)
  }

  // --- CreditNote ---
  for (let i = 0; i < creditNoteBatch.length; i += BATCH) {
    const batch = creditNoteBatch.slice(i, i + BATCH)
    await prisma.creditNote.createMany({
      data: batch.map(r => {
        const row = r.row
        const primary = r.resolvedOrders[0].order
        return {
          name: row.number,
          customerId: primary.restaurantId,
          customerName: primary.restaurantName,
          creditDate: toDateTime(row.date_invoice) ?? toDateTime(row.create_date) ?? new Date(),
          subtotalExTax: round2(toNum(row.amount_untaxed)),
          totalTax: round2(toNum(row.amount_tax)),
          totalIncTax: round2(toNum(row.amount_total)),
          status: mapCreditNoteStatus(row.state),
          createdAt: toDateTime(row.create_date) ?? new Date(),
        }
      }),
      skipDuplicates: true,
    })
    creditNotesCreated += batch.length

    const names = batch.map(r => r.row.number)
    const created = await prisma.creditNote.findMany({ where: { name: { in: names } }, select: { id: true, name: true } })
    const idByName = new Map(created.map(c => [c.name, c.id]))

    const lineCreates: {
      creditNoteId: string; productId: string; productName: string
      quantity: number; unitPrice: number; taxRate: number
      subtotalExTax: number; taxAmount: number; subtotalIncTax: number
      sourceOrderId?: string; sequence: number
    }[] = []
    for (const r of batch) {
      const creditNoteId = idByName.get(r.row.number)
      if (!creditNoteId) continue
      const lineRows = linesByInvoiceId.get(r.row.id) ?? []
      const codeToOrderId = new Map(r.resolvedOrders.map(o => [o.code, o.order.id]))
      lineRows.forEach((l, idx) => {
        const productId = prodByExt.get(l.product_id)
        if (!productId) { lineProductMissing++; return }
        const subtotal = toNum(l.price_subtotal)
        const total = toNum(l.price_total)
        lineCreates.push({
          creditNoteId,
          productId,
          productName: l.name || '(未命名商品)',
          quantity: toNum(l.quantity),
          unitPrice: round2(toNum(l.price_unit)),
          taxRate: subtotal !== 0 ? Math.round(((total - subtotal) / subtotal) * 10000) / 10000 : 0,
          subtotalExTax: round2(subtotal),
          taxAmount: round2(total - subtotal),
          subtotalIncTax: round2(total),
          sourceOrderId: codeToOrderId.get(l.origin),
          sequence: idx,
        })
      })
    }
    for (let j = 0; j < lineCreates.length; j += LINE_CHUNK) {
      await prisma.creditNoteLine.createMany({ data: lineCreates.slice(j, j + LINE_CHUNK) })
    }
    creditNoteLinesCreated += lineCreates.length

    if (creditNotesCreated % 2000 < BATCH) console.log(`  ...CreditNote 进度 ${creditNotesCreated}/${creditNoteBatch.length}`)
  }

  console.log(`\n✅ 完成：新建 Invoice ${invoicesCreated} / 新建 CreditNote ${creditNotesCreated}（行 ${creditNoteLinesCreated}）`)
  if (lineProductMissing > 0) console.log(`⚠️ ${lineProductMissing} 条贷记单行因商品未匹配被跳过`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
