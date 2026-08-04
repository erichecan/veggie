/**
 * scripts/import-test-orders-odoo-20260714.ts
 *
 * 一次性测试数据导入：从 Odoo 导出的 980 张非退货销售单(sale.order (7).csv，
 * 每行=一条订单明细，同一订单跨多行)灌入本地 Order/OrderLine，目的是让运营在
 * 订单列表(orders)、配送调度中心(dispatch-console)、日销售中心/打印中心(daily-sales)
 * 三个页面上跑通显示与交互，不追求库存/司机提成数字准确。
 *
 * 已知与真实业务流程的差异(用户已确认可接受)：
 *   - 跳过报价单阶段，直接落 status=CONFIRMED
 *   - 不走 /api/orders 的确认扣库存逻辑(直连 DB 写，不产生 StockMove/扣 qtyOnHand)
 *   - deliveryDate 统一改写为 2026-07-10(不用 Odoo 原始 Order Date)，避免和当前
 *     正在跑的真实调度日混在一起
 *   - 司机分配 round-robin 分给 5 个真实 DriverSlot，并调用与 app 相同的
 *     assignOrderToWave() + 回填 wave.assignmentDoneAt，让三个页面都有数据可看
 *
 * 标记与清理：
 *   - 每张导入的订单 externalRef = "test-import-2026-07-14:<Odoo External ID>"
 *   - 清理时: DELETE FROM "Order" WHERE "externalRef" LIKE 'test-import-2026-07-14:%'
 *     (OrderLine 有 onDelete: Cascade，随 Order 一起删；Pallet.items/wave.orderIds
 *     里残留的订单 id 引用不会自动清，需要用 scripts 里的 wave 孤儿清理逻辑或手工核对，
 *     见 cleanup-dispatched-wave-orphans.ts 的思路)
 *
 * 匹配规则：
 *   - CSV "Customer"           = __export__.res_partner_<num>_<hash>       → Customer.externalId(纯数字)
 *   - CSV "Order Lines/Product"= __export__.product_product_<num>_<hash>   → Product.externalId(纯数字)
 *   - Customer 匹配不到 → 整单跳过(不臆造客户)
 *   - Product 匹配不到 → 只跳过该行，订单其余行仍导入；若全部行都匹配不到则整单跳过
 *
 * 运行：
 *   node --import tsx -r dotenv/config scripts/import-test-orders-odoo-20260714.ts dotenv_config_path=.env.local            # dry-run
 *   node --import tsx -r dotenv/config scripts/import-test-orders-odoo-20260714.ts dotenv_config_path=.env.local --apply    # 实际写入
 */
import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import { assignOrderToWave } from '../lib/wave-assign'
import { syncOrderItemsSnapshot } from '../lib/order-items'

const prisma = createPrismaClient()

const APPLY = process.argv.includes('--apply')
const CSV_PATH = '/Users/eric/Downloads/sale.order (7).csv'
const TAG_PREFIX = 'test-import-2026-07-14:'
const IMPORT_LIMIT = 100
const DELIVERY_DATE = new Date('2026-07-10T00:00:00Z')
const DRIVER_NAMES_WANTED: { driverName: string; timeOfDay: string }[] = [
  { driverName: 'BAO', timeOfDay: 'pm' },
  { driverName: 'John', timeOfDay: 'am' },
  { driverName: 'ANDRIUS', timeOfDay: 'am' },
  { driverName: 'AFZAAL', timeOfDay: 'am' },
  { driverName: 'ASHWIN', timeOfDay: 'am' },
]

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

// CSV 用真实换行分隔字段内容(如商品描述里的中英双语换行)，纯按 \n split 行会把一行订单
// 明细拆散——必须按引号配对状态扫描，奇数个未闭合引号时把下一物理行接回来。
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

const numExt = (s: string, prefix: string): string => {
  const m = s.match(new RegExp(prefix + '_(\\d+)'))
  return m ? m[1] : ''
}
const toNum = (s: string): number => {
  const n = Number(String(s ?? '').trim())
  return Number.isFinite(n) ? n : 0
}

async function main() {
  // 1) 参照表：Customer/Product externalId(纯数字) → 本地记录
  const customers = await prisma.customer.findMany({ where: { NOT: { externalId: null } }, select: { id: true, name: true, externalId: true } })
  const custByExt = new Map<string, { id: string; name: string }>()
  for (const c of customers) if (c.externalId) custByExt.set(c.externalId, { id: c.id, name: c.name })

  const products = await prisma.product.findMany({
    where: { NOT: { externalId: null } },
    select: { id: true, name: true, spec: true, customerTaxRate: true, commissionPrice: true, externalId: true, template: { select: { uom: { select: { name: true } } } } },
  })
  const prodByExt = new Map<string, typeof products[number]>()
  for (const p of products) if (p.externalId) prodByExt.set(p.externalId, p)

  // 2) 司机批次：取 5 个真实 slot 做 round-robin
  const wantedSlots = await prisma.driverSlot.findMany({
    where: { archived: false, OR: DRIVER_NAMES_WANTED.map(w => ({ driverName: w.driverName, timeOfDay: w.timeOfDay })) },
    select: { id: true, driverName: true, timeOfDay: true, batchNum: true },
  })
  const slotByKey = new Map<string, string>()
  for (const s of wantedSlots) {
    const key = `${s.driverName}|${s.timeOfDay}`
    if (!slotByKey.has(key) || s.batchNum < (wantedSlots.find(x => slotByKey.get(key) === x.id)?.batchNum ?? Infinity)) {
      slotByKey.set(key, s.id)
    }
  }
  const driverSlotIds = DRIVER_NAMES_WANTED.map(w => slotByKey.get(`${w.driverName}|${w.timeOfDay}`)).filter((x): x is string => !!x)
  if (driverSlotIds.length === 0) throw new Error('没有找到任何目标司机批次，检查 DRIVER_NAMES_WANTED')

  // 3) 幂等：已导入过的订单(同 externalRef 前缀)跳过，支持重复运行
  const already = await prisma.order.findMany({ where: { externalRef: { startsWith: TAG_PREFIX } }, select: { externalRef: true } })
  const alreadySet = new Set(already.map(o => o.externalRef!))

  // 4) 解析 CSV，按 External ID 分组(每行=一条明细，订单级字段在每行重复)
  const raw = fs.readFileSync(CSV_PATH, 'utf-8').replace(/\r\n/g, '\n')
  const rows = parseCSVRows(raw)
  const header = rows[0]
  const col = (name: string) => header.indexOf(name)
  const idx = {
    extId: col('External ID'),
    code: col('Order Reference'),
    customer: col('Customer'),
    internalNote: col('Internal Notes'),
    invoiceStatus: col('Invoice Status'),
    orderDate: col('Order Date'),
    total: col('Total'),
    status: col('Status'),
    lineQty: col('Order Lines/Ordered Quantity'),
    linePrice: col('Order Lines/Unit Price'),
    lineSubtotal: col('Order Lines/Subtotal'),
    lineProduct: col('Order Lines/Product'),
    lineProductName: col('Order Lines/Product Name'),
    lineDesc: col('Order Lines/Description'),
  }
  for (const [k, v] of Object.entries(idx)) if (v < 0) throw new Error(`CSV 缺少列: ${k}`)

  // Odoo 导出一对多字段(Order Lines)时，只有每组的第一行填订单级字段(External ID/
  // Customer/...)，第 2 条起该订单的后续明细行订单级字段全部留空，只有 Order Lines/*
  // 有值——必须把空 External ID 的行接到"当前分组"而不是丢弃，否则每单只会留下第一条明细。
  type Group = { extId: string; code: string; customerExt: string; internalNote: string; lines: string[][] }
  const groups = new Map<string, Group>()
  let current: Group | null = null
  for (const r of rows.slice(1)) {
    if (r.length < header.length) continue
    const extId = r[idx.extId]?.trim()
    if (extId) {
      current = { extId, code: r[idx.code]?.trim() ?? '', customerExt: numExt(r[idx.customer] ?? '', 'res_partner'), internalNote: r[idx.internalNote] ?? '', lines: [] }
      groups.set(extId, current)
    }
    if (!current) continue
    current.lines.push(r)
  }

  // 5) 逐单匹配并构建待写入数据
  type PreparedLine = { productId: string; productName: string; spec: string | null; uomName: string | null; unitPrice: number; orderedQty: number; subtotal: number; taxRate: number | null; commissionPrice: number | null; sequence: number }
  type PreparedOrder = { extId: string; code: string; restaurantId: string; restaurantName: string; internalNote: string; lines: PreparedLine[]; totalAmount: number }

  const prepared: PreparedOrder[] = []
  let skippedNoCustomer = 0
  let skippedNoLines = 0
  let skippedAlready = 0
  let lineSkippedNoProduct = 0
  let lineMatched = 0

  for (const g of groups.values()) {
    const tag = TAG_PREFIX + g.extId
    if (alreadySet.has(tag)) { skippedAlready++; continue }
    const cust = custByExt.get(g.customerExt)
    if (!cust) { skippedNoCustomer++; continue }

    const lines: PreparedLine[] = []
    let seq = 0
    for (const r of g.lines) {
      const prodExt = numExt(r[idx.lineProduct] ?? '', 'product_product')
      const prod = prodByExt.get(prodExt)
      if (!prod) { lineSkippedNoProduct++; continue }
      lineMatched++
      const qty = toNum(r[idx.lineQty])
      const price = toNum(r[idx.linePrice])
      const subtotal = toNum(r[idx.lineSubtotal])
      lines.push({
        productId: prod.id,
        productName: prod.name,
        spec: prod.spec,
        uomName: prod.template?.uom?.name ?? null,
        unitPrice: price,
        orderedQty: qty,
        subtotal,
        taxRate: prod.customerTaxRate ? Number(prod.customerTaxRate) : null,
        commissionPrice: prod.commissionPrice ? Number(prod.commissionPrice) : null,
        sequence: seq++,
      })
    }
    if (lines.length === 0) { skippedNoLines++; continue }

    prepared.push({
      extId: g.extId,
      code: `TEST-${g.code || g.extId}`,
      restaurantId: cust.id,
      restaurantName: cust.name,
      internalNote: g.internalNote,
      lines,
      totalAmount: lines.reduce((s, l) => s + l.subtotal, 0),
    })
  }

  // 用户要求只导入 IMPORT_LIMIT 条，且要有"具体商品信息"——优先挑明细行数多的订单，
  // 让打印中心/托盘展示能看到多商品的真实场景，而不是清一色 1 行的极简单据。
  const allMatched = prepared.length
  prepared.sort((a, b) => b.lines.length - a.lines.length)
  const selected = prepared.slice(0, IMPORT_LIMIT)

  console.log('── CSV 解析 ──')
  console.log(`  CSV 订单数(去重后): ${groups.size}`)
  console.log(`  已导入过(幂等跳过): ${skippedAlready}`)
  console.log(`  客户匹配不到(跳过整单): ${skippedNoCustomer}`)
  console.log(`  全部商品行都匹配不到(跳过整单): ${skippedNoLines}`)
  console.log(`  商品行: 匹配 ${lineMatched} / 跳过 ${lineSkippedNoProduct}`)
  console.log(`  可导入订单数(全部): ${allMatched}`)
  console.log(`  本次实际导入(取明细行数最多的前 ${IMPORT_LIMIT} 单): ${selected.length}`)
  console.log('  示例(前5，已按明细行数从多到少排序):')
  for (const p of selected.slice(0, 5)) {
    console.log(`    ${p.code} | ${p.restaurantName} | ${p.lines.length}行 | €${p.totalAmount.toFixed(2)}`)
  }
  console.log(`\n  司机批次(round-robin): ${driverSlotIds.length} 个 → ${DRIVER_NAMES_WANTED.map(w => `${w.driverName}/${w.timeOfDay}`).join(', ')}`)
  console.log(`  deliveryDate 统一设为: ${DELIVERY_DATE.toISOString().slice(0, 10)}`)

  if (!APPLY) {
    console.log('\n[DRY-RUN] 未写入。加 --apply 实际执行。')
    return
  }

  console.log(`\n[APPLY] 开始导入 ${selected.length} 个订单…`)
  const touchedWaveIds = new Set<string>()
  let done = 0
  for (const p of selected) {
    const slotId = driverSlotIds[done % driverSlotIds.length]
    const order = await prisma.order.create({
      data: {
        code: p.code,
        restaurantId: p.restaurantId,
        restaurantName: p.restaurantName,
        status: 'CONFIRMED',
        paymentMethod: 'ONLINE',
        externalRef: TAG_PREFIX + p.extId,
        internalNote: p.internalNote || null,
        confirmationDate: new Date(),
        deliveryDate: DELIVERY_DATE,
        totalAmount: p.totalAmount,
        lines: { create: p.lines.map(l => ({
          productId: l.productId,
          productName: l.productName,
          spec: l.spec,
          uomName: l.uomName,
          unitPrice: l.unitPrice,
          orderedQty: l.orderedQty,
          subtotal: l.subtotal,
          taxRate: l.taxRate,
          commissionPrice: l.commissionPrice,
          sequence: l.sequence,
        })) },
      },
    })
    // assignOrderToWave 内部按 order.items(JSON 快照)拼托盘内容；order.create 时 items
    // 默认 []，必须先用 lines 回填快照，否则 Pallet 里这单的商品是空的
    await syncOrderItemsSnapshot(prisma, order.id)
    const assigned = await assignOrderToWave(order.id, slotId)
    if (assigned) touchedWaveIds.add(assigned.waveId)
    done++
    if (done % 50 === 0 || done === selected.length) console.log(`  …${done}/${selected.length}`)
  }

  console.log(`\n[APPLY] 标记 ${touchedWaveIds.size} 个波次「分配完成」…`)
  for (const waveId of touchedWaveIds) {
    await prisma.pickingWave.update({ where: { id: waveId }, data: { assignmentDoneAt: new Date() } })
  }

  console.log(`✅ 完成：导入 ${done} 个订单，覆盖 ${touchedWaveIds.size} 个波次`)
}

main().catch(e => { console.error(e); process.exit(1) }).finally(() => prisma.$disconnect())
