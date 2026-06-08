/**
 * 交易测试数据生成器（可重跑）
 * =====================================================================
 * 目的：在不触碰主数据（客户/产品/价格表/用户）的前提下，
 *      挂在真实客户 + 真实价格表价格上，造一批覆盖全业务链路、全状态的
 *      订单及其下游单据（拣货波次 / 行程 / 发票 / 对账单 / 信用票），
 *      让报价、价格覆盖、拣货拆分、发票结算、历史欠款等模块可端到端体验。
 *
 * 安全：所有生成记录均带可识别标记，重跑时只删带标记的交易数据再重建，
 *      绝不删除/修改客户、产品、价格表、用户、计量单位等主数据。
 *   - Order.externalRef = 'seed-tx'
 *   - Invoice.name      前缀 'TST-INV-'
 *   - Statement.tenantId = 'seed-tx'
 *   - CreditNote.name   前缀 'TST-CN-'
 *   - Trip.name         前缀 '[TST] '
 *   - PickingWave.name  前缀 '[TST] '
 *   - OrderLine / DeliverySlip 随 Order 级联删除
 *
 * 运行：DOTENV_CONFIG_PATH=.env.local npx tsx scripts/seed-transactions.ts
 */
import 'dotenv/config'
import { prisma } from '../lib/db'

const MARK = 'seed-tx'
const INV_PREFIX = 'TST-INV-'
const CN_PREFIX = 'TST-CN-'
const TRIP_PREFIX = '[TST] '
const WAVE_PREFIX = '[TST] '

// ─── 工具函数 ──────────────────────────────────────────────────────────────
const round2 = (n: number) => Math.round(n * 100) / 100
const rint = (min: number, max: number) => Math.floor(Math.random() * (max - min + 1)) + min
const pick = <T>(arr: T[]): T => arr[rint(0, arr.length - 1)]
function pickN<T>(arr: T[], n: number): T[] {
  const copy = [...arr]
  const out: T[] = []
  for (let i = 0; i < n && copy.length; i++) out.push(copy.splice(rint(0, copy.length - 1), 1)[0])
  return out
}
const DAY = 86_400_000
function daysAgo(d: number, hour = 9): Date {
  const base = new Date()
  base.setHours(hour, rint(0, 59), 0, 0)
  return new Date(base.getTime() - d * DAY)
}
const ymd = (d: Date) => d.toISOString().slice(0, 10)
const yymmdd = (d: Date) => d.toISOString().slice(2, 10).replace(/-/g, '')

// ─── 类型 ──────────────────────────────────────────────────────────────────
interface UsableItem { productId: string; productName: string; unitPrice: number; taxRate: number }
interface Cand {
  id: string; name: string; pricelistId: string; priceType: string
  address: string; items: UsableItem[]
}
type OrderStatus = 'PENDING' | 'CONFIRMED' | 'WAVE_ASSIGNED' | 'IN_DELIVERY' | 'COMPLETED' | 'LOCKED' | 'CANCELLED'

// ─── 1. 清理旧的测试交易数据 ───────────────────────────────────────────────
async function cleanup() {
  console.log('🧹 清理旧测试交易数据（仅带标记的记录）…')
  // CreditNoteLine 随 CreditNote 级联
  const cnDel = await prisma.creditNote.deleteMany({ where: { name: { startsWith: CN_PREFIX } } })
  const stDel = await prisma.statement.deleteMany({ where: { tenantId: MARK } })
  const invDel = await prisma.invoice.deleteMany({ where: { name: { startsWith: INV_PREFIX } } })
  const trDel = await prisma.trip.deleteMany({ where: { name: { startsWith: TRIP_PREFIX } } })
  const pwDel = await prisma.pickingWave.deleteMany({ where: { name: { startsWith: WAVE_PREFIX } } })
  // OrderLine / DeliverySlip / OrderDiscrepancy / OrderAuditLog 随 Order 级联删除
  const odDel = await prisma.order.deleteMany({ where: { externalRef: MARK } })
  console.log(`   删除：订单 ${odDel.count} · 波次 ${pwDel.count} · 行程 ${trDel.count} · 发票 ${invDel.count} · 对账单 ${stDel.count} · 信用票 ${cnDel.count}`)
}

// ─── 2. 加载候选客户 + 真实价格表行 ────────────────────────────────────────
async function loadCandidates(want: number): Promise<Cand[]> {
  const customers = await prisma.customer.findMany({
    where: { pricelistId: { not: null }, isCustomer: true, priceType: 'multi', isActive: true },
    select: { id: true, name: true, pricelistId: true, address: true, street: true, city: true },
    take: want * 3,
    orderBy: { createdAt: 'asc' },
  })
  const plIds = [...new Set(customers.map(c => c.pricelistId!))]
  const pls = await prisma.odooPricelist.findMany({ where: { id: { in: plIds } }, select: { id: true, items: true } })
  const plMap = new Map(pls.map(p => [p.id, (p.items as unknown[] as Array<Record<string, unknown>>) || []]))

  const allVarIds = new Set<string>()
  for (const items of plMap.values())
    for (const it of items)
      if (it.computeType === 'fixed' && it.fixedPrice != null && it.productVariantId) allVarIds.add(String(it.productVariantId))

  const prods = await prisma.product.findMany({
    where: { id: { in: [...allVarIds] }, active: true },
    select: { id: true, name: true, customerTaxRate: true },
  })
  const prodMap = new Map(prods.map(p => [p.id, p]))

  const out: Cand[] = []
  for (const c of customers) {
    const raw = plMap.get(c.pricelistId!) || []
    const usable: UsableItem[] = []
    const seen = new Set<string>()
    for (const it of raw) {
      if (it.computeType !== 'fixed' || it.fixedPrice == null || !it.productVariantId) continue
      const pid = String(it.productVariantId)
      if (seen.has(pid)) continue
      const prod = prodMap.get(pid)
      if (!prod) continue
      seen.add(pid)
      usable.push({
        productId: pid,
        productName: prod.name,
        unitPrice: round2(Number(it.fixedPrice)),
        taxRate: prod.customerTaxRate != null ? Number(prod.customerTaxRate) : 0,
      })
    }
    if (usable.length < 3) continue
    out.push({
      id: c.id, name: c.name, pricelistId: c.pricelistId!, priceType: 'multi',
      address: c.address || [c.street, c.city].filter(Boolean).join(', ') || 'Dublin',
      items: usable,
    })
    if (out.length >= want) break
  }
  return out
}

// ─── 订单分配计划 ──────────────────────────────────────────────────────────
// 单条订单的分配信息：状态 + 客户 + 所属配送批次（司机时段 + 送货日）。
// 配送阶段订单按"批次"成组生成，同一批次 = 同一 (送货日, 司机)，含多家不同客户。
// 额外两类多样性：
//   · 重复客户：指定客户在 2-3 个不同批次出现 → 测同客户跨批次合并
//   · 跨 AM/PM 整日波次：一个波次的订单分属 am 与 pm 两个司机时段
interface Assign {
  status: OrderStatus
  slotId: string | null
  driverName: string | null
  createdAt: Date
  deliveryDate: Date | null
  custIdx: number
  crossGroup?: number   // 同一 crossGroup 的订单组成一个跨 AM/PM 波次
}

type Slot = { id: string; driverName: string; timeOfDay: string }

function buildAssignments(slots: Slot[], custCount: number): Assign[] {
  const A: Assign[] = []
  const amSlots = slots.filter(s => s.timeOfDay === 'am')
  const pmSlots = slots.filter(s => s.timeOfDay === 'pm')

  // 客户轮转（覆盖全部客户，保证批次内不重复）
  let freshPtr = 0
  const nextFresh = () => { const v = freshPtr % custCount; freshPtr++; return v }
  // 重复客户：保留前 3 个客户索引，稍后注入多个批次
  const repeatIds = [0, 1, 2].filter(x => x < custCount)

  // 非配送阶段：不进批次
  const simple = (status: OrderStatus, n: number) => {
    for (let i = 0; i < n; i++) {
      const createdAt = daysAgo(rint(1, 30))
      const noDelivery = status === 'PENDING' || status === 'CANCELLED'
      const deliveryDate = noDelivery ? null : new Date(createdAt.getTime() + rint(1, 3) * DAY)
      A.push({ status, slotId: null, driverName: null, createdAt, deliveryDate, custIdx: nextFresh() })
    }
  }
  simple('PENDING', 15)
  simple('CONFIRMED', 12)
  simple('CANCELLED', 3)
  simple('LOCKED', 8)

  // 配送批次：每批唯一 (ymd, slot)
  const usedKey = new Set<string>()
  const amShuf = pickN(amSlots, amSlots.length)
  let amPtr = 0
  const nextAm = () => amShuf[(amPtr++) % amShuf.length]
  const claimSlotDate = (slot: Slot, base: number): Date => {
    let date = daysAgo(base)
    let tries = 0
    while (usedKey.has(`${ymd(date)}|${slot.id}`) && tries < 90) { date = new Date(date.getTime() + DAY); tries++ }
    usedKey.add(`${ymd(date)}|${slot.id}`)
    return date
  }

  interface Batch { status: OrderStatus; slot: Slot; date: Date; size: number; members: number[] }
  const specs: Array<[OrderStatus, number, number]> = [
    ['WAVE_ASSIGNED', 4, -rint(0, 2)], ['WAVE_ASSIGNED', 3, -rint(0, 2)], ['WAVE_ASSIGNED', 2, -rint(0, 2)], ['WAVE_ASSIGNED', 1, -rint(0, 2)],
    ['IN_DELIVERY', 4, rint(0, 2)], ['IN_DELIVERY', 3, rint(0, 2)], ['IN_DELIVERY', 2, rint(0, 2)], ['IN_DELIVERY', 1, rint(0, 2)],
    ['COMPLETED', 5, rint(3, 12)], ['COMPLETED', 3, rint(3, 12)], ['COMPLETED', 2, rint(3, 12)], ['COMPLETED', 1, rint(3, 12)], ['COMPLETED', 1, rint(3, 12)],
  ]
  const batches: Batch[] = specs.map(([status, size, base]) => {
    const slot = nextAm()
    return { status, slot, date: claimSlotDate(slot, base), size, members: [] }
  })

  // 先填充新客户（批次内不重复）
  for (const b of batches) {
    const used = new Set<number>()
    while (b.members.length < b.size) {
      let c = nextFresh(); let g = 0
      while (used.has(c) && g < custCount) { c = nextFresh(); g++ }
      used.add(c); b.members.push(c)
    }
  }
  // 注入重复客户：每个重复客户进入 2-3 个不含它的批次（替换一个成员）
  for (const r of repeatIds) {
    const targets = pickN(batches.filter(b => !b.members.includes(r)), rint(2, 3))
    for (const b of targets) {
      const idx = rint(0, b.members.length - 1)
      if (!b.members.includes(r)) b.members[idx] = r
    }
  }
  // 展开批次为订单
  for (const b of batches) {
    for (const c of b.members) {
      A.push({ status: b.status, slotId: b.slot.id, driverName: b.slot.driverName, createdAt: new Date(b.date.getTime() - rint(1, 3) * DAY), deliveryDate: b.date, custIdx: c })
    }
  }

  // 跨 AM/PM 整日波次：4 单同一天，2 单走 am 司机、2 单走 pm 司机
  if (amShuf.length > 0 && pmSlots.length > 0) {
    const am = nextAm()
    const pm = pmSlots[rint(0, pmSlots.length - 1)]
    let date = daysAgo(-rint(0, 2)); let tries = 0
    while ((usedKey.has(`${ymd(date)}|${am.id}`) || usedKey.has(`${ymd(date)}|${pm.id}`)) && tries < 90) { date = new Date(date.getTime() + DAY); tries++ }
    usedKey.add(`${ymd(date)}|${am.id}`); usedKey.add(`${ymd(date)}|${pm.id}`)
    const used = new Set<number>()
    for (let i = 0; i < 4; i++) {
      let c = nextFresh(); let g = 0
      while (used.has(c) && g < custCount) { c = nextFresh(); g++ }
      used.add(c)
      const slot = i < 2 ? am : pm
      A.push({ status: 'WAVE_ASSIGNED', slotId: slot.id, driverName: slot.driverName, createdAt: new Date(date.getTime() - rint(1, 3) * DAY), deliveryDate: date, custIdx: c, crossGroup: 1 })
    }
  }

  return A
}

interface BuiltOrder {
  id: string; status: OrderStatus; customer: Cand
  deliveryDate: Date; driverSlotId: string | null; driverName: string | null
  lines: Array<UsableItem & { orderedQty: number; deliveredQty: number; invoicedQty: number; subtotal: number }>
  totalAmount: number; createdAt: Date; crossGroup?: number
}

// 补充 pm 司机时段（现存全是 am，需 pm 才能造跨 AM/PM 波次）。按 driverName 幂等 upsert。
async function ensurePmSlots() {
  const pm = ['Marco', 'Tariq', 'Chen']
  for (const driverName of pm) {
    await prisma.driverSlot.upsert({
      where: { driverName },
      update: { timeOfDay: 'pm', batchNum: 2, archived: false },
      create: { driverName, timeOfDay: 'pm', batchNum: 2 },
    })
  }
}

// 演示库存：CSV 导入的商品 qtyOnHand 全为 0，下单时 ATP(可承诺量)=0 触发缺货告警。
// 给在售商品补充健康库存（300–1500），仅补"库存不足 100"的，不覆盖已有健康库存。
// 阈值参考：下单页 LOW_STOCK_THRESHOLD=20，待出取自未出库订单，故 300+ 足够稳。
async function ensureDemoStock() {
  const updated = await prisma.$executeRawUnsafe(
    `UPDATE "Product"
       SET "qtyOnHand" = (floor(random() * 1200)::int + 300),
           "safetyStockMin" = 20,
           "updatedAt" = NOW()
     WHERE active = true AND "qtyOnHand" < 100`,
  )
  console.log(`✅ 演示库存：为 ${updated} 个在售商品补充 qtyOnHand（300–1500，安全库存 20）`)
}

// ─── 3. 主流程 ─────────────────────────────────────────────────────────────
async function main() {
  await cleanup()
  await ensureDemoStock()

  const customers = await loadCandidates(30)
  if (customers.length < 5) throw new Error(`可用客户不足：${customers.length}`)
  console.log(`✅ 选定客户：${customers.length} 家（均挂真实价格表）`)

  await ensurePmSlots()
  const slots = await prisma.driverSlot.findMany({ where: { archived: false }, select: { id: true, driverName: true, timeOfDay: true } })
  if (slots.length === 0) throw new Error('无 DriverSlot，无法生成配送数据')

  const assigns = buildAssignments(slots, customers.length)
  const codeCounter: Record<string, number> = {}
  const built: BuiltOrder[] = []

  // ── 3a. 创建订单 + 订单行 ──（客户按序轮转 → 同一批次内客户各不相同）
  for (let i = 0; i < assigns.length; i++) {
    const a = assigns[i]
    const status = a.status
    const customer = customers[a.custIdx % customers.length]
    const lineCount = Math.min(rint(2, 5), customer.items.length)
    const chosen = pickN(customer.items, lineCount)

    const createdAt = a.createdAt
    const deliveryDate = a.deliveryDate
    const fullyDelivered = status === 'COMPLETED' || status === 'LOCKED'
    const invoiced = status === 'LOCKED'
    const inDelivery = status === 'IN_DELIVERY'

    const lines = chosen.map((it, seq) => {
      const orderedQty = rint(1, 30)
      const deliveredQty = fullyDelivered ? orderedQty : inDelivery ? (Math.random() < 0.7 ? orderedQty : 0) : 0
      const invoicedQty = invoiced ? deliveredQty : 0
      return { ...it, sequence: seq, orderedQty, deliveredQty, invoicedQty, subtotal: round2(it.unitPrice * orderedQty) }
    })
    const totalAmount = round2(lines.reduce((s, l) => s + l.subtotal, 0))

    const dayKey = yymmdd(createdAt)
    codeCounter[dayKey] = (codeCounter[dayKey] || 0) + 1
    const code = `TST-${dayKey}-${String(codeCounter[dayKey]).padStart(3, '0')}`

    const order = await prisma.order.create({
      data: {
        code,
        externalRef: MARK,
        restaurantId: customer.id,
        restaurantName: customer.name,
        createdByName: 'Seed Bot',
        salesman: pick(['CJ', 'AMY', 'LEO']),
        items: lines.map(l => ({ productId: l.productId, name: l.productName, qty: l.orderedQty, unitPrice: l.unitPrice, subtotal: l.subtotal })),
        totalAmount,
        status: status as never,
        paymentMethod: pick(['ONLINE', 'CASH']) as never,
        pricelistId: customer.pricelistId,
        priceType: customer.priceType,
        createdAt,
        quotationDate: createdAt,
        confirmationDate: status === 'PENDING' || status === 'CANCELLED' ? null : new Date(createdAt.getTime() + 3600_000),
        deliveryDate,
        invoiceDate: invoiced ? deliveryDate : null,
        sentAt: status === 'PENDING' && Math.random() < 0.5 ? new Date(createdAt.getTime() + 1800_000) : null,
        lockedAt: invoiced && deliveryDate ? new Date(deliveryDate.getTime() + 3600_000) : null,
        orderReturn: status === 'COMPLETED' && Math.random() < 0.3,
        driverSlotId: a.slotId,
        lines: {
          create: lines.map(l => ({
            productId: l.productId,
            productName: l.productName,
            unitPrice: l.unitPrice,
            taxRate: l.taxRate,
            orderedQty: l.orderedQty,
            deliveredQty: l.deliveredQty,
            invoicedQty: l.invoicedQty,
            subtotal: l.subtotal,
            sequence: l.sequence,
          })),
        },
      },
    })

    built.push({
      id: order.id, status, customer, deliveryDate: deliveryDate ?? createdAt, driverSlotId: a.slotId,
      driverName: a.driverName, lines, totalAmount, createdAt, crossGroup: a.crossGroup,
    })
  }
  console.log(`✅ 订单：${built.length} 条（含订单行），配送阶段已按批次聚合`)

  // ── 3b. DeliverySlip（已确认及以后的订单生成送货单）──
  let slipN = 0
  for (const o of built) {
    if (o.status === 'PENDING' || o.status === 'CANCELLED') continue
    await prisma.deliverySlip.create({
      data: { orderId: o.id, customerId: o.customer.id, customerName: o.customer.name, deliveryDate: o.deliveryDate },
    })
    slipN++
  }
  console.log(`✅ 送货单：${slipN} 条`)

  // ── 3c. PickingWave（WAVE_ASSIGNED + IN_DELIVERY 按 日期+司机 分组；跨 AM/PM 单独处理）──
  const waveGroups = new Map<string, { date: Date; slotId: string; driver: string; orderIds: string[] }>()
  for (const o of built) {
    if (o.crossGroup) continue // 跨 AM/PM 订单不进单时段波次
    if ((o.status !== 'WAVE_ASSIGNED' && o.status !== 'IN_DELIVERY') || !o.driverSlotId) continue
    const key = `${ymd(o.deliveryDate)}__${o.driverSlotId}`
    if (!waveGroups.has(key)) waveGroups.set(key, { date: o.deliveryDate, slotId: o.driverSlotId, driver: o.driverName!, orderIds: [] })
    waveGroups.get(key)!.orderIds.push(o.id)
  }
  // (waveDate, driverSlotId) 唯一：避开库里已有真实波次及彼此占用的组合
  const existingWaves = await prisma.pickingWave.findMany({
    where: { waveDate: { not: null }, driverSlotId: { not: null } },
    select: { waveDate: true, driverSlotId: true },
  })
  const takenWave = new Set(existingWaves.map(w => `${ymd(w.waveDate!)}|${w.driverSlotId}`))
  let waveN = 0
  for (const g of waveGroups.values()) {
    let date = new Date(ymd(g.date))
    for (let tries = 0; takenWave.has(`${ymd(date)}|${g.slotId}`) && tries < 90; tries++)
      date = new Date(date.getTime() + DAY)
    if (takenWave.has(`${ymd(date)}|${g.slotId}`)) continue // 实在无空位则跳过该波次
    takenWave.add(`${ymd(date)}|${g.slotId}`)
    waveN++
    await prisma.pickingWave.create({
      data: {
        name: `${WAVE_PREFIX}${ymd(date)} ${g.driver}`,
        orderIds: g.orderIds,
        status: 'PENDING' as never,
        waveDate: date,
        waveNumber: waveN,
        waveType: 'TEST',
        driverSlotId: g.slotId,
        driverName: g.driver,
      },
    })
  }

  // 跨 AM/PM 整日波次：driverSlotId=null（不占单时段唯一槽），orderIds 含 am+pm 两组订单
  const crossOrders = built.filter(o => o.crossGroup)
  let crossWaveN = 0
  if (crossOrders.length > 0) {
    const drivers = [...new Set(crossOrders.map(o => o.driverName))].join(' + ')
    waveN++; crossWaveN = 1
    await prisma.pickingWave.create({
      data: {
        name: `${WAVE_PREFIX}整日(AM+PM) ${drivers}`,
        orderIds: crossOrders.map(o => o.id),
        status: 'PENDING' as never,
        waveDate: new Date(ymd(crossOrders[0].deliveryDate)),
        waveNumber: waveN,
        waveType: 'FULL_DAY',
        driverSlotId: null,
        driverName: drivers,
      },
    })
  }
  console.log(`✅ 拣货波次：${waveN} 条（含跨 AM/PM 整日波次 ${crossWaveN} 条）`)

  // ── 3d. Trip（IN_DELIVERY → IN_PROGRESS，COMPLETED → COMPLETED，按司机分组）──
  function buildRestaurant(o: BuiltOrder, delivered: boolean) {
    return {
      restaurantId: o.customer.id,
      restaurantName: o.customer.name,
      address: o.customer.address,
      orderIds: [o.id],
      items: o.lines.map(l => ({ productId: l.productId, name: l.productName, qty: l.orderedQty, unitPrice: l.unitPrice, subtotal: l.subtotal })),
      delivered,
      returns: [],
      pods: [],
      cargoVerified: true,
    }
  }
  const tripGroups = new Map<string, { driver: string; status: 'IN_PROGRESS' | 'COMPLETED'; orders: BuiltOrder[] }>()
  for (const o of built) {
    if (o.status !== 'IN_DELIVERY' && o.status !== 'COMPLETED') continue
    if (!o.driverName) continue
    const tStatus = o.status === 'IN_DELIVERY' ? 'IN_PROGRESS' : 'COMPLETED'
    const key = `${ymd(o.deliveryDate)}__${o.driverName}__${tStatus}`
    if (!tripGroups.has(key)) tripGroups.set(key, { driver: o.driverName, status: tStatus, orders: [] })
    tripGroups.get(key)!.orders.push(o)
  }
  let tripN = 0
  for (const g of tripGroups.values()) {
    tripN++
    const completed = g.status === 'COMPLETED'
    const restaurants = g.orders.map(o => buildRestaurant(o, completed || Math.random() < 0.5))
    const totalPayment = round2(g.orders.reduce((s, o) => s + o.totalAmount, 0))
    await prisma.trip.create({
      data: {
        name: `${TRIP_PREFIX}${g.driver} · ${g.orders.length}家`,
        timeSlot: pick(['AM', 'PM']),
        driverName: g.driver,
        departTime: completed ? '07:30' : '13:00',
        status: g.status as never,
        restaurants: restaurants as never,
        totalPayment,
        cashCollected: completed ? round2(totalPayment * 0.6) : 0,
        onlineCollected: completed ? round2(totalPayment * 0.4) : 0,
        settlementStatus: completed ? 'confirmed' : 'pending',
        settledAt: completed ? new Date() : null,
        settledBy: completed ? 'Seed Bot' : null,
      },
    })
  }
  console.log(`✅ 行程：${tripN} 条（IN_PROGRESS + COMPLETED）`)

  // ── 3e. Invoice（COMPLETED 一半 + 全部 LOCKED；镜像 POST /api/invoices 算法）──
  let invN = 0
  const invoicedCustomers = new Map<string, { orderIds: string[]; invoiceIds: string[]; period: Date }>()
  for (const o of built) {
    const shouldInvoice = o.status === 'LOCKED' || (o.status === 'COMPLETED' && Math.random() < 0.5)
    if (!shouldInvoice) continue
    const invLines = o.lines.map(l => {
      const qty = l.deliveredQty > 0 ? l.deliveredQty : l.orderedQty
      const exTax = round2(qty * l.unitPrice)
      const taxAmt = round2(exTax * l.taxRate)
      return {
        productId: l.productId, productName: l.productName, spec: '',
        qty, unitPrice: l.unitPrice, taxRate: l.taxRate,
        subtotalExTax: exTax, taxAmount: taxAmt, subtotalIncTax: round2(exTax + taxAmt),
      }
    })
    const subtotalExTax = round2(invLines.reduce((s, l) => s + l.subtotalExTax, 0))
    const totalTax = round2(invLines.reduce((s, l) => s + l.taxAmount, 0))
    const totalIncTax = round2(subtotalExTax + totalTax)
    // InvoiceStatus 仅 DRAFT/POSTED/PAID/CANCELLED；部分付款 = POSTED + 半额 amountPaid
    const statusRoll = o.status === 'LOCKED' ? pick(['POSTED', 'PAID']) : pick(['DRAFT', 'POSTED', 'PAID'])
    const partial = statusRoll === 'POSTED' && Math.random() < 0.5
    const amountPaid = statusRoll === 'PAID' ? totalIncTax : partial ? round2(totalIncTax / 2) : 0
    invN++
    const inv = await prisma.invoice.create({
      data: {
        name: `${INV_PREFIX}${String(invN).padStart(4, '0')}`,
        customerId: o.customer.id,
        customerName: o.customer.name,
        saleOrderIds: [o.id],
        lines: invLines as never,
        subtotalExTax, totalTax, totalIncTax,
        amountPaid, amountDue: round2(totalIncTax - amountPaid),
        status: statusRoll as never,
        paymentTerms: 'monthly',
        createdAt: o.deliveryDate,
        postedAt: statusRoll !== 'DRAFT' ? o.deliveryDate.toISOString() : null,
        paidAt: statusRoll === 'PAID' ? new Date(o.deliveryDate.getTime() + DAY).toISOString() : null,
      },
    })
    const agg = invoicedCustomers.get(o.customer.id) || { orderIds: [], invoiceIds: [], period: o.deliveryDate }
    agg.orderIds.push(o.id); agg.invoiceIds.push(inv.id)
    invoicedCustomers.set(o.customer.id, agg)
  }
  console.log(`✅ 发票：${invN} 条（DRAFT/POSTED/PAID/PARTIAL 混合）`)

  // ── 3f. Statement（给有发票的前 6 家客户造月度对账单）──
  const periodStart = new Date(ymd(daysAgo(35)).slice(0, 8) + '01')
  const periodEnd = daysAgo(0)
  let stN = 0
  for (const [custId, agg] of [...invoicedCustomers.entries()].slice(0, 6)) {
    const cust = customers.find(c => c.id === custId)!
    // 本期销售 = 该客户 CONFIRMED+ 订单总额
    const custOrders = built.filter(o => o.customer.id === custId && o.status !== 'PENDING' && o.status !== 'CANCELLED')
    const totalSales = round2(custOrders.reduce((s, o) => s + o.totalAmount, 0))
    const paidInvoices = await prisma.invoice.findMany({
      where: { customerId: custId, amountPaid: { gt: 0 } },
      select: { amountPaid: true },
    })
    const totalPayments = round2(paidInvoices.reduce((s, i) => s + Number(i.amountPaid), 0))
    const openingBalance = round2(rint(0, 500)) // 模拟历史欠款
    const closingBalance = round2(openingBalance + totalSales - totalPayments)
    stN++
    await prisma.statement.create({
      data: {
        tenantId: MARK,
        customerId: custId,
        customerName: cust.name,
        periodStart, periodEnd,
        openingBalance, totalSales, totalPayments, closingBalance,
        orderIds: custOrders.map(o => o.id),
        invoiceIds: agg.invoiceIds,
        status: pick(['draft', 'confirmed', 'sent']),
      },
    })
  }
  console.log(`✅ 对账单：${stN} 条（含历史欠款 openingBalance）`)

  // ── 3g. CreditNote（给有完成订单的前 3 家客户造退货信用票）──
  const completedOrders = built.filter(o => o.status === 'COMPLETED' || o.status === 'LOCKED')
  const cnTargets = pickN(completedOrders, Math.min(3, completedOrders.length))
  let cnN = 0
  for (const o of cnTargets) {
    const cnLines = pickN(o.lines, Math.min(2, o.lines.length)).map((l, seq) => {
      const quantity = rint(1, Math.max(1, Math.floor((l.deliveredQty || l.orderedQty) / 2)))
      const exTax = round2(quantity * l.unitPrice)
      const taxAmt = round2(exTax * l.taxRate)
      return {
        productId: l.productId, productName: l.productName,
        quantity, unitPrice: l.unitPrice, taxRate: l.taxRate,
        subtotalExTax: exTax, taxAmount: taxAmt, subtotalIncTax: round2(exTax + taxAmt),
        reason: pick(['货物破损', '数量短缺', '质量问题']),
        sourceOrderId: o.id, sequence: seq,
      }
    })
    const subtotalExTax = round2(cnLines.reduce((s, l) => s + l.subtotalExTax, 0))
    const totalTax = round2(cnLines.reduce((s, l) => s + l.taxAmount, 0))
    cnN++
    await prisma.creditNote.create({
      data: {
        name: `${CN_PREFIX}${String(cnN).padStart(3, '0')}`,
        customerId: o.customer.id,
        customerName: o.customer.name,
        creditDate: o.deliveryDate,
        subtotalExTax, totalTax, totalIncTax: round2(subtotalExTax + totalTax),
        status: pick(['CONFIRMED', 'APPLIED']),
        createdBy: MARK,
        notes: '测试退货信用票',
        lines: { create: cnLines },
      },
    })
  }
  console.log(`✅ 信用票：${cnN} 条（含 CreditNoteLine）`)

  console.log('\n🎉 交易测试数据生成完成')
}

main()
  .catch(e => { console.error('❌ 生成失败:', e); process.exit(1) })
  .finally(() => prisma.$disconnect())
