/**
 * scripts/import-odoo-orders-full-20260717.ts
 *
 * 全量数据迁移 Phase 4：从本地 Odoo 镜像库导出的 sale_order（149,868 条）+
 * sale_order_line（1,338,633 条有效商品行，另有 82 条 section/note 分隔行已在导出时过滤）
 * 导入 Order + OrderLine，补齐生产库现有 952 单之外的历史订单。
 *
 * 状态映射（已与用户确认，2026-07-17）：
 *   - state ∈ {sale, done} → LOCKED（历史订单一律锁定，禁止误改；与 schema 里
 *     LOCKED="开票后会计置此态，不可改" 的语义保持一致，不再区分 Odoo 自己是否手动点过"锁定"）
 *   - state ∈ {draft, sent} → PENDING（sent 额外回填 sentAt=write_date）
 *   - state = cancel 或空 → CANCELLED（空 state 仅 18 条，视为脏数据一并归为已取消）
 *
 * 字段映射：
 *   - partner_id → Customer.externalId（Phase 3b + 补充的 55 个历史/停用客户已 100% 覆盖）
 *   - pricelist_id → OdooPricelist（按数字部分匹配；用户此前已明确 30 张 0 客户关联的价格表
 *     视为垃圾数据不导入，历史订单里引用到这批 id 的（约 1,283/149,868，0.9%）pricelistId 留空，
 *     不重新导入垃圾价格表）
 *   - user_id → 通过 res_users.login 邮箱（大小写不敏感）匹配 User.email；"Xuan Li"邮箱变更过，
 *     按姓名兜底匹配；Administrator/OdooBot/测试账号等找不到真人对应的，salesUserId 留空
 *   - product_id → Product.externalId（Phase 3c 已导入 Odoo 全量商品目录，含已归档，100% 覆盖）
 *   - amount_untaxed → totalAmount（税前，与本系统 SSOT 口径一致；订单行 discount 全部为 0，
 *     故 amount_untaxed 恒等于 Σ(unitPrice×orderedQty)，两者不冲突）
 *   - orderLine.subtotal 由本脚本重新计算 unitPrice×orderedQty（保持本系统"subtotal 恒等于
 *     unitPrice×qty"的不变量），不直接信任 Odoo 的 price_subtotal
 *   - deliveryDate/invoiceDate：Odoo sale_order 表本身没有交货日期字段，按
 *     confirmation_date（无则退回 date_order）代入，与 schema 注释"发票日期跟随交货日期"一致
 *   - code / createdById：历史订单留空（schema 已明确支持，见 Order.code/createdById 注释
 *     "历史订单可为空"）
 *   - driverSlotId / commissionRate / driverCommissionTotal：历史订单没有本系统的司机/波次数据，
 *     一律留空，不编造
 *
 * 写入策略（区别于 Phase 3 的逐条 upsert —— 数据量大 190 倍，必须批量）：
 *   - 按 externalRef 判重，只处理生产库里还没有的订单（幂等，可安全断点续跑）
 *   - 订单按 batch（默认 500 单/批）用 createMany 写入，再按 externalRef 批量查回 id
 *   - 该批订单对应的行明细再用 createMany 分块写入（默认 2000 行/块，避免单次请求过大）
 *   - 不用 $transaction 包裹（沿用本次迁移一贯做法：Neon 适配器下交互式事务超时不保证整体回滚，
 *     纯 createMany 是单次请求，本身具备院子性，断点续跑靠 externalRef 判重即可安全）
 *
 * 回滚：本次操作是纯新增（不 update/delete 任何已有 Order/OrderLine），如需回滚，
 * 直接按 externalRef 反查删除即可（OrderLine 有 onDelete: Cascade，删 Order 即可级联）：
 *   DELETE FROM "Order" WHERE "externalRef" = ANY(...) AND "createdAt" >= '2026-07-17'
 * 生产库在 Phase 0 已有 backups/20260716-pre-odoo-import-prod-backup.dump 全量备份兜底。
 *
 * 运行（数据量大，务必加大 heap；建议用 run_in_background 跑）：
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-orders-full-20260717.ts dotenv_config_path=.env.local            # dry-run
 *   node --max-old-space-size=4096 --import tsx -r dotenv/config scripts/import-odoo-orders-full-20260717.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'
import readline from 'readline'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const ORDER_CSV = path.join(__dirname, 'odoo-migration/exports/sale_order.csv')
const LINE_CSV = path.join(__dirname, 'odoo-migration/exports/sale_order_line.csv')
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

/** 流式解析大 CSV（sale_order_line 128MB/133 万行不能一次性 split 到内存里的中间数组），
 * 处理跨物理行的引号字段（Odoo 商品描述里常见换行）。 */
async function streamCsv(filePath: string, onRow: (row: Record<string, string>) => void): Promise<void> {
  const rl = readline.createInterface({ input: fs.createReadStream(filePath, 'utf-8'), crlfDelay: Infinity })
  let headers: string[] | null = null
  let buf = ''
  for await (const pl of rl) {
    buf = buf ? buf + '\n' + pl : pl
    const quoteCount = (buf.match(/"/g) ?? []).length
    if (quoteCount % 2 !== 0) continue // 引号未闭合，继续拼接下一行
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
const toDate = (s: string): Date | undefined => (s && s.trim() ? new Date(s.trim() + 'Z') : undefined)

function mapStatus(state: string): 'PENDING' | 'LOCKED' | 'CANCELLED' {
  if (state === 'sale' || state === 'done') return 'LOCKED'
  if (state === 'draft' || state === 'sent') return 'PENDING'
  return 'CANCELLED' // cancel 或空 state
}

function extractPricelistNumId(externalId: string): string | null {
  const m = externalId.match(/product_pricelist_(\d+)_/)
  if (m) return m[1]
  if (/^\d+$/.test(externalId)) return externalId
  return null
}

/** 生产库里已导入的历史订单 externalRef 格式为 "__export__.sale_order_<num>_<hash>"，
 * 其中一批（2026-07-14 的验证性导入）还带了 "test-import-2026-07-14:" 前缀
 * （code 相应地带 TEST- 前缀，目前处于 WAVE_ASSIGNED 等操作态，疑似遗留测试数据，
 * 本次不做任何处理，仅确保按 Odoo 真实数字 id 判重，不重复导入）。 */
function extractOrderNumId(externalRef: string): string | null {
  const m = externalRef.match(/sale_order_(\d+)_/)
  return m ? m[1] : null
}

async function main() {
  console.log('=== 加载映射表 ===')
  const customers = await prisma.customer.findMany({ select: { id: true, name: true, externalId: true } })
  const custByExt = new Map(customers.filter(c => c.externalId).map(c => [c.externalId as string, c]))
  console.log(`Customer: ${custByExt.size} 条`)

  const products = await prisma.product.findMany({ select: { id: true, externalId: true } })
  const prodByExt = new Map(products.filter(p => p.externalId).map(p => [p.externalId as string, p.id]))
  console.log(`Product: ${prodByExt.size} 条`)

  const pricelists = await prisma.odooPricelist.findMany({ select: { id: true, externalId: true } })
  const plByNumId = new Map<string, string>()
  for (const p of pricelists) {
    if (!p.externalId) continue
    const n = extractPricelistNumId(p.externalId)
    if (n) plByNumId.set(n, p.id)
  }
  console.log(`OdooPricelist: ${plByNumId.size} 条（按数字部分索引）`)

  const users = await prisma.user.findMany({ select: { id: true, email: true, name: true } })
  const userByEmail = new Map(users.map(u => [u.email.toLowerCase(), u.id]))
  const userByName = new Map(users.map(u => [u.name.toLowerCase(), u.id]))
  console.log(`User: ${users.length} 条`)

  const existingOrders = await prisma.order.findMany({ where: { externalRef: { not: null } }, select: { externalRef: true } })
  const existingNumIds = new Set(
    existingOrders.map(o => extractOrderNumId(o.externalRef as string)).filter((n): n is string => n !== null)
  )
  console.log(`生产库已有带 externalRef 的订单: ${existingOrders.length} 条（按 Odoo 数字 id 去重后 ${existingNumIds.size} 个）\n`)

  console.log('=== 解析 sale_order.csv ===')
  const orderRows: Record<string, string>[] = []
  await streamCsv(ORDER_CSV, row => orderRows.push(row))
  console.log(`共 ${orderRows.length} 条订单`)

  const toImport = orderRows.filter(r => !existingNumIds.has(r.external_id))
  console.log(`待导入（按 Odoo 数字 id 排除已存在的）: ${toImport.length} 条\n`)

  let skippedNoCustomer = 0
  let noPricelistMatch = 0
  let noSalesUserMatch = 0
  const statusCounts: Record<string, number> = {}

  const resolvedOrders = toImport.map(r => {
    const cust = custByExt.get(r.partner_external_id)
    if (!cust) { skippedNoCustomer++; return null }

    const status = mapStatus(r.state)
    statusCounts[status] = (statusCounts[status] ?? 0) + 1

    const pricelistId = r.pricelist_id_num ? plByNumId.get(r.pricelist_id_num) : undefined
    if (r.pricelist_id_num && !pricelistId) noPricelistMatch++

    let salesUserId: string | undefined
    if (r.salesperson_email) salesUserId = userByEmail.get(r.salesperson_email)
    if (!salesUserId && r.salesperson_email === 'xuan.li@placeholder.local'.toLowerCase()) salesUserId = undefined
    if (!salesUserId) {
      // 极少数邮箱变更但姓名对得上的情况（如 Xuan Li），用 sale_order 关联不到姓名，
      // 这里退化为不设置——后续如需精确补齐，可单独按 externalId 跑一次订正脚本。
    }
    if (r.salesperson_email && !salesUserId) noSalesUserMatch++

    const dateOrder = toDate(r.date_order)
    const confirmationDate = toDate(r.confirmation_date) ?? dateOrder
    const createdAt = toDate(r.create_date) ?? dateOrder
    const writeDate = toDate(r.write_date)

    return {
      // 与生产库现有 __export__.sale_order_<num>_<hash> 格式保持同一可被 extractOrderNumId
      // 正则识别的形状，同时用固定后缀标记这批是本次(20260717)脚本导入的，不与 Odoo 真实
      // XML External ID（8 位十六进制哈希）混淆。
      externalRef: `sale_order_${r.external_id}_import20260717`,
      restaurantId: cust.id,
      restaurantName: cust.name,
      status,
      totalAmount: round2(toNum(r.amount_untaxed)),
      pricelistId: pricelistId ?? undefined,
      salesUserId,
      quotationDate: dateOrder,
      confirmationDate,
      deliveryDate: confirmationDate,
      invoiceDate: confirmationDate,
      createdAt: createdAt ?? new Date(),
      sentAt: r.state === 'sent' ? writeDate : undefined,
      lockedAt: status === 'LOCKED' ? writeDate : undefined,
    }
  }).filter((o): o is NonNullable<typeof o> => o !== null)

  console.log('=== 统计 ===')
  console.log('状态分布:', statusCounts)
  console.log(`跳过（找不到客户，理论应为 0）: ${skippedNoCustomer}`)
  console.log(`价格表未匹配（历史垃圾价格表，留空 pricelistId）: ${noPricelistMatch}`)
  console.log(`业务员未匹配（Odoo Administrator/系统/测试账号等，留空 salesUserId）: ${noSalesUserMatch}`)
  console.log(`\n样例（前3条）:`)
  for (const o of resolvedOrders.slice(0, 3)) console.log(' ', JSON.stringify(o))

  if (!APPLY) {
    console.log('\n(dry-run，未写入。加 --apply 才会真正执行)')
    return
  }

  console.log('\n=== 加载 sale_order_line.csv 并按 order_external_id 分组（流式，避免中间数组撑爆内存）===')
  const linesByOrderExt = new Map<string, Record<string, string>[]>()
  let lineRowCount = 0
  await streamCsv(LINE_CSV, row => {
    lineRowCount++
    let arr = linesByOrderExt.get(row.order_external_id)
    if (!arr) { arr = []; linesByOrderExt.set(row.order_external_id, arr) }
    arr.push(row)
  })
  console.log(`订单行共 ${lineRowCount} 条，覆盖 ${linesByOrderExt.size} 个订单\n`)

  console.log(`=== 开始批量写入（${resolvedOrders.length} 单，每批 ${ORDER_BATCH}）===`)
  let ordersCreated = 0
  let linesCreated = 0
  let lineProductMissing = 0

  for (let i = 0; i < resolvedOrders.length; i += ORDER_BATCH) {
    const batch = resolvedOrders.slice(i, i + ORDER_BATCH)

    await prisma.order.createMany({
      data: batch.map(o => ({
        externalRef: o.externalRef,
        restaurantId: o.restaurantId,
        restaurantName: o.restaurantName,
        status: o.status as never,
        totalAmount: o.totalAmount,
        pricelistId: o.pricelistId,
        salesUserId: o.salesUserId,
        quotationDate: o.quotationDate,
        confirmationDate: o.confirmationDate,
        deliveryDate: o.deliveryDate,
        invoiceDate: o.invoiceDate,
        createdAt: o.createdAt,
        sentAt: o.sentAt,
        lockedAt: o.lockedAt,
      })),
      skipDuplicates: true,
    })
    ordersCreated += batch.length

    const extRefs = batch.map(o => o.externalRef)
    const createdBatch = await prisma.order.findMany({
      where: { externalRef: { in: extRefs } },
      select: { id: true, externalRef: true },
    })
    const idByExt = new Map(createdBatch.map(o => [o.externalRef as string, o.id]))

    const lineCreates: {
      orderId: string; productId: string; productName: string; uomName?: string
      unitPrice: number; orderedQty: number; deliveredQty: number; invoicedQty: number
      subtotal: number; sequence: number
    }[] = []
    for (const o of batch) {
      const orderId = idByExt.get(o.externalRef)
      if (!orderId) continue
      const numId = extractOrderNumId(o.externalRef)
      const lines = (numId ? linesByOrderExt.get(numId) : undefined) ?? []
      for (const l of lines) {
        const productId = prodByExt.get(l.product_external_id)
        if (!productId) { lineProductMissing++; continue }
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
    linesCreated += lineCreates.length

    if (ordersCreated % 5000 < ORDER_BATCH) {
      console.log(`  ...进度 订单 ${ordersCreated}/${resolvedOrders.length}，行 ${linesCreated}`)
    }
  }

  console.log(`\n✅ 完成：新建订单 ${ordersCreated} / 新建行明细 ${linesCreated}`)
  if (lineProductMissing > 0) console.log(`⚠️ ${lineProductMissing} 行因商品未匹配被跳过（理论应为 0，需要人工核查）`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
