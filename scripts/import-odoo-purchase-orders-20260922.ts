/**
 * scripts/import-odoo-purchase-orders-20260922.ts
 *
 * 历史采购单全量导入：Odoo 在生产库里从未导入过 purchase.order/purchase.order.line
 * （只导过 res.partner 供应商主档），导致 Purchase Analysis 里能查到的历史供货记录
 * （2022-01-09 ~ 2026-07-12，15,449 单 / 58,255 行）在 veggie 里完全查不到。
 *
 * 数据来源：归档的完整 Odoo12 pg_dump（非重新连 Odoo 服务器）：
 *   /Volumes/datacenter/04-eric/AIcoding/_archive/odoo12-full-dump-20260716.sql
 * 用 scripts/odoo-migration/extract-purchase-from-full-dump.py 直接从 COPY 块抠出
 *   scripts/odoo-migration/exports/purchase_order.csv / purchase_order_line.csv
 *
 * 字段映射（与 2026-07-17 销售单导入脚本同一套惯例）：
 *   - name：直接用 Odoo 原始单号（如 "P000103"）写入 PurchaseOrder.name（该字段本身 @unique），
 *     天然做去重/幂等键，不新增 externalRef 字段；不与 veggie 原生 "PO-00001" 格式冲突
 *   - supplierId：Customer.externalId == partner_id（覆盖率 99.97%，194/203 个 isVendor
 *     供应商已有 externalId；找不到的 4 个供应商对应的单子跳过，不编造）
 *   - productId：Product.externalId == product_id（覆盖率 100%）
 *   - 状态：purchase/done → LOCKED（历史已完成单据锁定，不可误改，与销售单导入同一惯例）；
 *     draft → DRAFT；cancel → CANCELLED；sent → SENT；to approve → TO_APPROVE（后两个 Odoo
 *     12 实际数据里没出现，兜底而已）
 *   - 金额：subtotalExTax/totalTax/totalIncTax 直接取 Odoo amount_untaxed/amount_tax/amount_total，
 *     不重新计算（行级同理取 price_subtotal/price_tax/price_total）
 *   - 币种：currency_id=1（15,435 单，99.9%）→ EUR，exchangeRate=1；currency_id=148（14 单，
 *     供应商国家码 GB）→ 判断为 GBP，但没有 res_currency 导出确认、也没有历史汇率，
 *     exchangeRatePending=true，*Eur 系列字段留空，不编造汇率
 *   - uomId：Odoo product_uom 是数字 id，与 veggie 自己 20260819 重整后的 Uom 表无可靠映射，
 *     historical 行统一留空（schema 本身允许 uomId 可空，"兼容"）
 *   - receivedQty/invoicedQty：Odoo qty_received/qty_invoiced 有值直接带入（比订单导入更完整）
 *   - taxRate：Odoo 行没有单独税率字段，用 price_tax/price_subtotal 反推
 *   - 不生成 GoodsReceipt/StockMove/VendorBill，不改当前库存——这批是历史记录导入，
 *     不是当前收货流程，与销售单导入不碰 StockMove 是同一原则
 *
 * 运行：
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-purchase-orders-20260922.ts dotenv_config_path=.env.local            # dry-run
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-purchase-orders-20260922.ts dotenv_config_path=.env.local --apply    # 实际写入
 *
 * 回滚：纯新增，按 name 前缀 "P0" + 长度特征即可反查（Odoo 单号格式固定 P+6位数字），
 * 或本次导入统计里记录的 name 列表精确删除；PurchaseOrderLine 有 onDelete: Cascade。
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const ORDER_CSV = path.join(__dirname, 'odoo-migration/exports/purchase_order.csv')
const LINE_CSV = path.join(__dirname, 'odoo-migration/exports/purchase_order_line.csv')
const ORDER_BATCH = 500
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

/** 按引号配对拼接物理行再解析——供应商名/备注等字段里常见真实换行，
 * 简单按 '\n' 切分会把一行拆成两条脏数据（20260922 实测 purchase_order.csv 里
 * 86 个物理行引号数为奇数，对应 43 处跨行字段，此前的朴素实现直接漏了/错了这些行）。 */
function loadCsv(filePath: string): Record<string, string>[] {
  const text = fs.readFileSync(filePath, 'utf-8')
  const physicalLines = text.split('\n')
  let headers: string[] | null = null
  const rows: Record<string, string>[] = []
  let buf = ''
  for (const pl of physicalLines) {
    buf = buf ? buf + '\n' + pl : pl
    const quoteCount = (buf.match(/"/g) ?? []).length
    if (quoteCount % 2 !== 0) continue // 引号未闭合，继续拼接下一物理行
    if (buf.trim().length === 0) { buf = ''; continue }
    const vals = parseCSVLine(buf)
    buf = ''
    if (!headers) { headers = vals; continue }
    const row: Record<string, string> = {}
    headers.forEach((h, i) => { row[h] = vals[i] ?? '' })
    rows.push(row)
  }
  return rows
}

const toNum = (s: string, d = 0) => { const n = parseFloat(s); return Number.isFinite(n) ? n : d }
const round2 = (n: number) => Math.round(n * 100) / 100
const round4 = (n: number) => Math.round(n * 10000) / 10000
const toDate = (s: string): Date | undefined => (s && s.trim() ? new Date(s.trim() + 'Z') : undefined)

type Status = 'DRAFT' | 'SENT' | 'TO_APPROVE' | 'CONFIRMED' | 'RECEIVED' | 'INVOICED' | 'LOCKED' | 'CANCELLED'

function mapStatus(state: string): Status {
  if (state === 'purchase' || state === 'done') return 'LOCKED'
  if (state === 'draft') return 'DRAFT'
  if (state === 'sent') return 'SENT'
  if (state === 'to approve') return 'TO_APPROVE'
  return 'CANCELLED' // cancel 或空/未知 state
}

async function main() {
  console.log('=== 加载映射表 ===')
  const customers = await prisma.customer.findMany({ where: { isVendor: true }, select: { id: true, name: true, externalId: true } })
  const custByExt = new Map(customers.filter(c => c.externalId).map(c => [c.externalId as string, c]))
  console.log(`Customer(isVendor=true, 有 externalId): ${custByExt.size} 条`)

  const products = await prisma.product.findMany({ select: { id: true, externalId: true } })
  const prodByExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p.id]))
  console.log(`Product: ${prodByExt.size} 条`)

  const existing = await prisma.purchaseOrder.findMany({ select: { name: true } })
  const existingNames = new Set(existing.map(o => o.name))
  console.log(`生产库已有采购单: ${existing.length} 条\n`)

  console.log('=== 解析 purchase_order.csv ===')
  const orderRows = loadCsv(ORDER_CSV)
  console.log(`共 ${orderRows.length} 条采购单`)

  const toImport = orderRows.filter(r => !existingNames.has(r.name))
  console.log(`待导入（按单号去重后）: ${toImport.length} 条\n`)

  let skippedNoSupplier = 0
  const statusCounts: Record<string, number> = {}
  const currencyCounts: Record<string, number> = {}
  const skippedSupplierIds = new Set<string>()

  const resolvedOrders = toImport.map(r => {
    const supplier = custByExt.get(r.partner_id)
    if (!supplier) { skippedNoSupplier++; skippedSupplierIds.add(r.partner_id); return null }

    const status = mapStatus(r.state)
    statusCounts[status] = (statusCounts[status] ?? 0) + 1

    const isEur = r.currency_id === '1'
    const currency = isEur ? 'EUR' : (r.currency_id === '148' ? 'GBP' : 'EUR')
    currencyCounts[currency] = (currencyCounts[currency] ?? 0) + 1

    const orderDate = toDate(r.date_order) ?? new Date()
    const expectedDate = toDate(r.date_planned)
    const createdAt = toDate(r.create_date) ?? orderDate
    const writeDate = toDate(r.write_date)
    const confirmedAt = toDate(r.date_approve)

    const subtotalExTax = round2(toNum(r.amount_untaxed))
    const totalTax = round2(toNum(r.amount_tax))
    const totalIncTax = round2(toNum(r.amount_total))

    return {
      name: r.name,
      supplierId: supplier.id,
      status,
      orderDate,
      expectedDate,
      currency,
      exchangeRate: isEur ? 1 : null,
      exchangeRatePending: !isEur,
      subtotalExTax,
      totalTax,
      totalIncTax,
      subtotalExTaxEur: isEur ? subtotalExTax : null,
      totalTaxEur: isEur ? totalTax : null,
      totalIncTaxEur: isEur ? totalIncTax : null,
      createdAt,
      confirmedAt,
      cancelledAt: status === 'CANCELLED' ? writeDate : undefined,
      lockedAt: status === 'LOCKED' ? writeDate : undefined,
    }
  }).filter((o): o is NonNullable<typeof o> => o !== null)

  console.log('=== 统计 ===')
  console.log('状态分布:', statusCounts)
  console.log('币种分布:', currencyCounts)
  console.log(`跳过（供应商 externalId 未覆盖，理论 ~4 个供应商）: ${skippedNoSupplier} 单，涉及 partner_id: ${[...skippedSupplierIds].join(',')}`)
  console.log(`\n样例（前3条）:`)
  for (const o of resolvedOrders.slice(0, 3)) console.log(' ', JSON.stringify(o))

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  console.log('\n=== 加载 purchase_order_line.csv 并按 order_id 分组 ===')
  const lineRows = loadCsv(LINE_CSV)
  const linesByOrderId = new Map<string, Record<string, string>[]>()
  for (const row of lineRows) {
    let arr = linesByOrderId.get(row.order_id)
    if (!arr) { arr = []; linesByOrderId.set(row.order_id, arr) }
    arr.push(row)
  }
  console.log(`订单行共 ${lineRows.length} 条，覆盖 ${linesByOrderId.size} 个订单\n`)

  // Odoo purchase_order.id（数字）→ name，用来在行明细里反查该订单对应的原始 id
  const odooIdByName = new Map(toImport.map(r => [r.name, r.id]))

  console.log(`=== 开始批量写入（${resolvedOrders.length} 单，每批 ${ORDER_BATCH}）===`)
  let ordersCreated = 0
  let linesCreated = 0
  let lineProductMissing = 0

  for (let i = 0; i < resolvedOrders.length; i += ORDER_BATCH) {
    const batch = resolvedOrders.slice(i, i + ORDER_BATCH)

    await prisma.purchaseOrder.createMany({
      data: batch.map(o => ({
        name: o.name,
        supplierId: o.supplierId,
        status: o.status as never,
        orderDate: o.orderDate,
        expectedDate: o.expectedDate,
        currency: o.currency,
        exchangeRate: o.exchangeRate,
        exchangeRatePending: o.exchangeRatePending,
        subtotalExTax: o.subtotalExTax,
        totalTax: o.totalTax,
        totalIncTax: o.totalIncTax,
        subtotalExTaxEur: o.subtotalExTaxEur,
        totalTaxEur: o.totalTaxEur,
        totalIncTaxEur: o.totalIncTaxEur,
        createdAt: o.createdAt,
        confirmedAt: o.confirmedAt,
        cancelledAt: o.cancelledAt,
        lockedAt: o.lockedAt,
      })),
      skipDuplicates: true,
    })
    ordersCreated += batch.length

    const names = batch.map(o => o.name)
    const createdBatch = await prisma.purchaseOrder.findMany({
      where: { name: { in: names } },
      select: { id: true, name: true },
    })
    const idByName = new Map(createdBatch.map(o => [o.name, o.id]))

    const lineCreates: {
      purchaseOrderId: string; productId: string; productName: string
      orderedQty: number; receivedQty: number; invoicedQty: number
      unitCost: number; taxRate: number
      subtotalExTax: number; taxAmount: number; subtotalIncTax: number
      unitCostEur?: number | null; subtotalExTaxEur?: number | null; taxAmountEur?: number | null; subtotalIncTaxEur?: number | null
      sequence: number
    }[] = []
    for (const o of batch) {
      const purchaseOrderId = idByName.get(o.name)
      if (!purchaseOrderId) continue
      const odooId = odooIdByName.get(o.name)
      const lines = (odooId ? linesByOrderId.get(odooId) : undefined) ?? []
      for (const l of lines) {
        const productId = prodByExt.get(l.product_id)
        if (!productId) { lineProductMissing++; continue }
        const unitCost = round4(toNum(l.price_unit))
        const orderedQty = toNum(l.product_qty)
        const subtotalExTax = round2(toNum(l.price_subtotal))
        const taxAmount = round2(toNum(l.price_tax))
        const subtotalIncTax = round2(toNum(l.price_total))
        const taxRate = subtotalExTax > 0 ? round4(taxAmount / subtotalExTax) : 0
        const isEur = o.currency === 'EUR'
        lineCreates.push({
          purchaseOrderId,
          productId,
          productName: l.name || '(未命名商品)',
          orderedQty,
          receivedQty: toNum(l.qty_received),
          invoicedQty: toNum(l.qty_invoiced),
          unitCost,
          taxRate,
          subtotalExTax,
          taxAmount,
          subtotalIncTax,
          unitCostEur: isEur ? unitCost : null,
          subtotalExTaxEur: isEur ? subtotalExTax : null,
          taxAmountEur: isEur ? taxAmount : null,
          subtotalIncTaxEur: isEur ? subtotalIncTax : null,
          sequence: Math.trunc(toNum(l.sequence)) || 10,
        })
      }
    }

    for (let j = 0; j < lineCreates.length; j += LINE_CHUNK) {
      await prisma.purchaseOrderLine.createMany({ data: lineCreates.slice(j, j + LINE_CHUNK) })
    }
    linesCreated += lineCreates.length

    if (ordersCreated % 5000 < ORDER_BATCH) {
      console.log(`  ...进度 订单 ${ordersCreated}/${resolvedOrders.length}，行 ${linesCreated}`)
    }
  }

  console.log(`\n✅ 完成：新建采购单 ${ordersCreated} / 新建行明细 ${linesCreated}`)
  if (lineProductMissing > 0) console.log(`⚠️ ${lineProductMissing} 行因商品未匹配被跳过（理论应为 0，需要人工核查）`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
