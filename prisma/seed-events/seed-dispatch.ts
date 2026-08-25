/**
 * 配送调度补种 · 独立可重复跑
 * ============================================================================
 * 目的：让「配送调度中心」当天有一套统一、事件驱动的配送数据——
 *   固定司机集 → 今日订单 → 波次(按司机批次) → 托盘编排 → 行程，全程贯通。
 * 运行：npm run db:seed:dispatch
 * 幂等：清理本脚本标记的订单/波次/行程后重建；清理所有 legacy Trip 重建一致行程。
 * 不破坏守恒：确认扣库存写 StockMove，末尾 recomputeOnHand；订单停在 CONFIRMED
 *           （与 assign 接口一致：入波次不改订单状态，批次板按 orderIds 解析渲染）。
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'
import { randomUUID } from 'crypto'
import { recomputeOnHand, ensureNonNegativeStock } from './inventory'

const prisma = createPrismaClient()

const DISP_REF = 'seed-dispatch'
const WAVE_PREFIX = 'DISP-WAVE-'
const TRIP_PREFIX = 'DISP-TRIP-'
const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000
const pick = <T>(arr: T[], n: number): T[] => [...arr].sort(() => Math.random() - 0.5).slice(0, n)

// 种子内造的 SALES 账号(幂等 upsert + 内存缓存,同进程多次调用只查一次)
let _kevinLeeIdPromise: Promise<string> | null = null
function getKevinLeeId(): Promise<string> {
  if (!_kevinLeeIdPromise) {
    _kevinLeeIdPromise = prisma.user.upsert({
      where: { email: 'seed-evt-kevin.lee@veggie.demo' },
      update: {},
      create: { email: 'seed-evt-kevin.lee@veggie.demo', name: 'Kevin Lee', passwordHash: '$2a$10$invalidSeedOnlyHashXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX', role: 'SALES', roles: ['OPERATOR', 'SALES'], isActive: true },
      select: { id: true },
    }).then(u => u.id)
  }
  return _kevinLeeIdPromise
}

// 固定司机集：上午 3 + 下午 3
const FIXED_DRIVERS = [
  { timeOfDay: 'am', batchNum: 1, driverName: 'BAO' },
  { timeOfDay: 'am', batchNum: 2, driverName: 'SEAN' },
  { timeOfDay: 'am', batchNum: 3, driverName: 'MING' },
  { timeOfDay: 'pm', batchNum: 1, driverName: 'AFZAAL' },
  { timeOfDay: 'pm', batchNum: 2, driverName: 'RAJ' },
  { timeOfDay: 'pm', batchNum: 3, driverName: 'ALI' },
]

interface Prod { id: string; name: string; sell: number; uomId: string | null; uomName: string }
interface Slot { id: string; driverName: string; timeOfDay: string; batchNum: number }
interface PItem { orderId: string; restaurantId: string; restaurantName: string; productId: string; productName: string; qty: number; uomName: string }
interface BuiltOrder { id: string; code: string; custId: string; custName: string; total: number; pay: 'CASH' | 'ONLINE'; items: PItem[] }

const dayStartUTC = () => {
  const d = new Date()
  return new Date(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}T00:00:00Z`)
}
const todayAt = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }

/** 固定司机集：upsert 6 个为 active，其余现有 active 槽位归档 */
async function setupDrivers(): Promise<Slot[]> {
  const out: Slot[] = []
  for (const d of FIXED_DRIVERS) {
    const s = await prisma.driverSlot.upsert({
      where: { timeOfDay_batchNum_driverName: { timeOfDay: d.timeOfDay, batchNum: d.batchNum, driverName: d.driverName } },
      update: { archived: false },
      create: d,
      select: { id: true, driverName: true, timeOfDay: true, batchNum: true },
    })
    out.push(s)
  }
  await prisma.driverSlot.updateMany({
    where: { driverName: { notIn: FIXED_DRIVERS.map(d => d.driverName) }, archived: false },
    data: { archived: true },
  })
  return out
}

async function cleanup(): Promise<void> {
  const old = await prisma.order.findMany({ where: { externalRef: DISP_REF }, select: { id: true } })
  const ids = old.map(o => o.id)
  if (ids.length) {
    await prisma.stockMove.deleteMany({ where: { sourceId: { in: ids } } })
    await prisma.deliverySlip.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.orderAuditLog.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.orderLine.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.order.deleteMany({ where: { id: { in: ids } } })
  }
  // 删本脚本波次 + 今天所有波次（控制台只看今天，避免 (waveDate,driverSlotId) 唯一冲突）
  const day = dayStartUTC()
  const next = new Date(day); next.setUTCDate(day.getUTCDate() + 1)
  await prisma.pickingWave.deleteMany({
    where: { OR: [{ name: { startsWith: WAVE_PREFIX } }, { waveDate: { gte: day, lt: next } }] },
  })
  // 清理重建：所有 legacy 行程清掉，由本脚本重建当天一致行程
  await prisma.trip.deleteMany({})
}

async function loadProducts(): Promise<Prod[]> {
  const rows = await prisma.product.findMany({
    where: { active: true, status: 'ACTIVE', type: 'PRODUCT', canBeSold: true },
    select: {
      id: true, name: true, listPrice: true, price: true,
      uomId: true, uom: { select: { name: true, nameZh: true } },
    },
    take: 200,
  })
  return rows.map(p => {
    const sell = Number(p.listPrice ?? p.price ?? 0) || round2(3 + Math.random() * 10)
    return {
      id: p.id, name: p.name, sell: round2(sell),
      uomId: p.uomId ?? null,
      uomName: p.uom?.nameZh ?? p.uom?.name ?? '份',
    }
  })
}

/** 建一张今日订单（CONFIRMED，扣库存），返回供后续编排托盘/波次用 */
async function makeOrder(
  operatorId: string, operatorName: string, seq: number,
  cust: { id: string; name: string }, products: Prod[], slotId: string | null,
): Promise<BuiltOrder> {
  const chosen = pick(products, 3 + Math.floor(Math.random() * 4))
  const pay: 'CASH' | 'ONLINE' = Math.random() < 0.5 ? 'CASH' : 'ONLINE'
  const id = randomUUID()
  const code = `DISP-${String(seq).padStart(5, '0')}`
  let total = 0
  const lineData = chosen.map((p, idx) => {
    const qty = 2 + Math.floor(Math.random() * 12)
    const subtotal = round2(p.sell * qty)
    total += subtotal
    return { productId: p.id, productName: p.name, uomId: p.uomId, uomName: p.uomName, unitPrice: p.sell, taxRate: 0, orderedQty: qty, deliveredQty: 0, invoicedQty: 0, subtotal, sequence: idx }
  })
  total = round2(total)
  const items = chosen.map((p, idx) => ({ productId: p.id, productName: p.name, spec: '', price: p.sell, quantity: lineData[idx].orderedQty, subtotal: lineData[idx].subtotal }))
  const palletItems: PItem[] = chosen.map((p, idx) => ({ orderId: id, restaurantId: cust.id, restaurantName: cust.name, productId: p.id, productName: p.name, qty: lineData[idx].orderedQty, uomName: p.uomName }))

  const day = dayStartUTC()
  const salesUserId = await getKevinLeeId()
  await prisma.$transaction([
    prisma.order.create({
      data: {
        id, code, createdById: operatorId, createdByName: operatorName,
        restaurantId: cust.id, restaurantName: cust.name, items, totalAmount: total,
        status: 'CONFIRMED', paymentMethod: pay, externalRef: DISP_REF, priceType: 'multi',
        commissionRate: 0.03, salesUserId, driverSlotId: slotId,
        quotationDate: day, confirmationDate: todayAt(9), deliveryDate: day, createdAt: todayAt(8),
        lines: { create: lineData },
      },
    }),
    prisma.deliverySlip.create({ data: { orderId: id, customerId: cust.id, customerName: cust.name, deliveryDate: day, createdAt: todayAt(9) } }),
    prisma.orderAuditLog.create({ data: { orderId: id, userId: operatorId, action: 'confirmed', totalAfter: total, createdAt: todayAt(9) } }),
    prisma.stockMove.createMany({
      data: chosen.map((p, idx) => ({ productId: p.id, productName: p.name, type: 'OUT' as const, qty: -round3(lineData[idx].orderedQty), note: `${DISP_REF} 确认出库 ${code}`, sourceType: 'SO', sourceId: id, sourceRef: code, movedAt: todayAt(9) })),
    }),
  ])
  return { id, code, custId: cust.id, custName: cust.name, total, pay, items: palletItems }
}

/** 波次按餐馆聚合 zones（拣货波次页用） */
function buildZones(orders: BuiltOrder[]) {
  const byRest = new Map<string, { name: string; items: Array<{ productId: string; productName: string; spec: string; image: string; requiredQty: number; pickedQty: number; restaurants: string[]; done: boolean; uomName: string }> }>()
  for (const o of orders) {
    let z = byRest.get(o.custName)
    if (!z) { z = { name: o.custName, items: [] }; byRest.set(o.custName, z) }
    for (const it of o.items) {
      const ex = z.items.find(x => x.productId === it.productId)
      if (ex) ex.requiredQty += it.qty
      else z.items.push({ productId: it.productId, productName: it.productName, spec: '', image: '', requiredQty: it.qty, pickedQty: 0, restaurants: [o.custName], done: false, uomName: it.uomName })
    }
  }
  return [...byRest.values()]
}

/** 编排托盘：把波次全部货明细轮流分到 n 个托盘（混装），返回 Pallet 创建数据 */
function buildPallets(orders: BuiltOrder[], n: number): Array<{ seq: number; items: PItem[] }> {
  const all = orders.flatMap(o => o.items)
  const pallets: PItem[][] = Array.from({ length: n }, () => [])
  all.forEach((it, i) => pallets[i % n].push(it))
  return pallets.map((items, i) => ({ seq: i + 1, items })).filter(p => p.items.length > 0)
}

async function main(): Promise<void> {
  const t0 = Date.now()
  console.log('🚚 配送调度补种启动...')
  const operator = await prisma.user.findFirst({ where: { role: 'OPERATOR' }, select: { id: true, name: true } })
  if (!operator) throw new Error('缺少 OPERATOR 用户，请先 npm run db:seed')

  await cleanup()
  const drivers = await setupDrivers()
  const products = await loadProducts()
  if (products.length === 0) throw new Error('没有可用商品，请先 npm run db:seed')

  const customers = await prisma.customer.findMany({
    where: { isCustomer: true, isActive: true, isVendor: false },
    select: { id: true, name: true }, orderBy: { createdAt: 'asc' }, take: 32,
  })
  if (customers.length < 12) throw new Error('客户不足，请先 npm run db:seed')

  const day = dayStartUTC()
  let seq = 1
  // 每个司机分 3 个餐馆组一波；前 6 个司机各一波，余下餐馆留作"待分配"
  const perDriver = 3
  let ci = 0
  const waveStatuses = ['SORTED', 'PICKING', 'SORTED', 'PENDING', 'PICKING', 'PENDING']
  let waveCount = 0, palletCount = 0, tripCount = 0

  for (let di = 0; di < drivers.length; di++) {
    const slot = drivers[di]
    const custs = customers.slice(ci, ci + perDriver)
    ci += perDriver
    if (custs.length === 0) break

    const orders: BuiltOrder[] = []
    for (const c of custs) orders.push(await makeOrder(operator.id, operator.name, seq++, c, products, slot.id))

    const status = waveStatuses[di] ?? 'PENDING'
    const wave = await prisma.pickingWave.create({
      data: {
        name: `${WAVE_PREFIX}${slot.driverName}`, orderIds: orders.map(o => o.id),
        zones: buildZones(orders), status: status as 'PENDING' | 'PICKING' | 'SORTED',
        waveType: slot.timeOfDay === 'pm' ? 'bulk' : 'loose',
        waveDate: day, driverSlotId: slot.id, driverName: slot.driverName, createdAt: todayAt(8),
      },
      select: { id: true },
    })
    // 订单保持 CONFIRMED：assign 接口要求 CONFIRMED 且不改状态，批次板按 orderIds 解析 CONFIRMED 订单渲染泳道
    waveCount++

    // 已就绪/理货中的波次编排托盘；待理货的留空（演示"待编排"）
    if (status !== 'PENDING') {
      const pallets = buildPallets(orders, slot.timeOfDay === 'pm' ? 3 : 2)
      await prisma.pallet.createMany({ data: pallets.map(p => ({ waveId: wave.id, seq: p.seq, label: null, items: p.items as object[] })) })
      palletCount += pallets.length
    }

    // 已就绪的波次配车（行程）；订单仍保持 CONFIRMED 以便批次板渲染，行程按自身快照展示
    if (status === 'SORTED') {
      const totalPayment = round2(orders.reduce((a, o) => a + o.total, 0))
      const cash = round2(orders.filter(o => o.pay === 'CASH').reduce((a, o) => a + o.total, 0))
      await prisma.trip.create({
        data: {
          name: `${TRIP_PREFIX}${slot.timeOfDay === 'am' ? 'AM' : 'PM'} · ${slot.driverName} · ${orders.length}家`,
          timeSlot: slot.timeOfDay === 'am' ? 'AM' : 'PM', driverName: slot.driverName,
          departTime: slot.timeOfDay === 'am' ? '08:30' : '14:00', status: 'IN_PROGRESS',
          restaurants: orders.map(o => ({ orderId: o.id, customerId: o.custId, customerName: o.custName, amount: o.total, paymentMethod: o.pay })),
          totalPayment, driverCommission: round2(totalPayment * 0.03),
          cashCollected: 0, onlineCollected: 0, settlementStatus: 'pending', createdAt: todayAt(10),
        },
      })
      tripCount++
    }
  }

  // 待分配池：剩余餐馆各下一单，CONFIRMED 不分波
  const rest = customers.slice(ci)
  let poolCount = 0
  for (const c of rest) { await makeOrder(operator.id, operator.name, seq++, c, products, null); poolCount++ }

  // 今日配送扣库存后，对卖超的商品做期初库存补足，保证 0 负库存
  const topped = await ensureNonNegativeStock(prisma, new Date(day.getTime() - 30 * 86_400_000))
  if (topped > 0) console.log(`📥 期初库存补足 ${topped} 个商品（避免卖超负库存）`)

  console.log('🧮 重算库存（守恒）...')
  await recomputeOnHand(prisma)

  console.log('\n──── 配送补种汇总 ────')
  console.log(`  固定司机 ${drivers.length}（上午3/下午3）`)
  console.log(`  今日波次 ${waveCount} · 托盘 ${palletCount} · 行程 ${tripCount}`)
  console.log(`  待分配订单 ${poolCount}`)
  console.log(`\n⏱  用时 ${((Date.now() - t0) / 1000).toFixed(1)}s · 打开「配送调度中心」查看今天`)
}

main()
  .then(async () => { await prisma.$disconnect() })
  .catch(async (e) => { console.error('💥 配送补种失败：', e); await prisma.$disconnect(); process.exit(1) })
