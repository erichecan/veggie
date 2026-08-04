/**
 * 缺货处理演示数据 · 安全补种（只增不删生产数据，可一键回滚）
 * ============================================================================
 * 目的：让「日销售管理中心 → 缺货处理」当天有一批可操作的订单。
 *   缺货处理页按 deliveryDate=今天 且 status∈{CONFIRMED,WAVE_ASSIGNED,IN_DELIVERY}
 *   拉取带订单行 + 司机槽位的订单。生产库里今天通常没有这类订单，故页面为空。
 *
 * 与现成 db:seed:dispatch 的区别（后者对生产库有破坏性，不能跑）：
 *   - 不归档任何现有司机槽位（复用真实 active 槽位，只读）
 *   - 不删除任何波次 / Trip / 其他订单
 *   - 只清理并重建本脚本自己标记（externalRef='seed-shortage-demo'）的订单
 *
 * 全链条自洽（复刻真实确认订单的副作用，与 orders/[id]/route.ts 语义一致）：
 *   Order(CONFIRMED) + OrderLine + items快照 + DeliverySlip + OrderAuditLog(confirmed)
 *   + 每 PRODUCT 行一条 StockMove(OUT, 负数) → 末尾 recomputeOnHand 保库存守恒。
 *   跑完可 `npm run db:validate` 校验不变量全过。
 *
 * 运行： npm run db:seed:shortage-demo          # 清理旧演示单后重建
 *        npm run db:seed:shortage-demo -- --clean # 只删演示单，不重建（一键回滚）
 * 幂等： 重复跑先删本脚本标记的订单再重建，不累积。
 */
import 'dotenv/config'
import { createPrismaClient } from '@/lib/prisma-factory'
import { randomUUID } from 'crypto'
import { recomputeOnHand, ensureNonNegativeStock } from './inventory'

const prisma = createPrismaClient()

const SHORTAGE_REF = 'seed-shortage-demo'
const CODE_PREFIX = 'SHDEMO-'
const ORDER_COUNT = 18
const DEMO_PRODUCT_COUNT = 3 // 缺货演示品：散布到多数订单，方便在缺货处理页搜到成批订单行

const round2 = (n: number) => Math.round(n * 100) / 100
const round3 = (n: number) => Math.round(n * 1000) / 1000

// 确定性随机（seeded，可复现），不用 Math.random 以保证同一天多次跑结果稳定
function mulberry32(seed: number) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
const rng = mulberry32(20260707)
const rInt = (min: number, max: number) => min + Math.floor(rng() * (max - min + 1))
const rShuffle = <T>(arr: T[]): T[] => {
  const a = [...arr]
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1))
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

const dayStartUTC = () => {
  const d = new Date()
  return new Date(`${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}T00:00:00Z`)
}
const todayAt = (h: number, m = 0) => { const d = new Date(); d.setHours(h, m, 0, 0); return d }

interface Prod { id: string; name: string; sell: number; taxRate: number; uomId: string | null; uomName: string }
interface Slot { id: string; driverName: string; timeOfDay: string }

/** 只清理本脚本标记的订单及其关联，绝不碰其他数据 */
async function cleanupOwn(): Promise<number> {
  const own = await prisma.order.findMany({ where: { externalRef: SHORTAGE_REF }, select: { id: true } })
  const ids = own.map(o => o.id)
  if (ids.length) {
    await prisma.stockMove.deleteMany({ where: { sourceId: { in: ids } } })
    await prisma.deliverySlip.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.orderAuditLog.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.orderLine.deleteMany({ where: { orderId: { in: ids } } })
    await prisma.order.deleteMany({ where: { id: { in: ids } } })
  }
  return ids.length
}

async function loadProducts(): Promise<Prod[]> {
  const rows = await prisma.product.findMany({
    where: { active: true, status: 'ACTIVE', template: { type: 'PRODUCT', canBeSold: true } },
    select: {
      id: true, name: true, listPrice: true, price: true, customerTaxRate: true,
      template: { select: { listPrice: true, customerTaxRate: true, uomId: true, uom: { select: { name: true, nameZh: true } } } },
    },
    orderBy: { name: 'asc' },
    take: 300,
  })
  return rows.map(p => {
    const sell = Number(p.listPrice ?? p.price ?? p.template?.listPrice ?? 0) || round2(3 + rng() * 10)
    const taxRate = Number(p.customerTaxRate ?? p.template?.customerTaxRate ?? 0)
    return {
      id: p.id, name: p.name, sell: round2(sell), taxRate,
      uomId: p.template?.uomId ?? null,
      uomName: p.template?.uom?.nameZh ?? p.template?.uom?.name ?? '份',
    }
  })
}

/** 复用现有 active 司机槽位，覆盖 AM/PM，同名去重（只读，不新建不归档） */
async function loadDriverSlots(): Promise<Slot[]> {
  const rows = await prisma.driverSlot.findMany({
    where: { archived: false },
    select: { id: true, driverName: true, timeOfDay: true, batchNum: true },
    orderBy: [{ timeOfDay: 'asc' }, { batchNum: 'asc' }],
  })
  const dedupe = (list: typeof rows) => {
    const seen = new Set<string>()
    const out: Slot[] = []
    for (const s of list) {
      if (seen.has(s.driverName)) continue
      seen.add(s.driverName)
      out.push({ id: s.id, driverName: s.driverName, timeOfDay: s.timeOfDay })
    }
    return out
  }
  const am = dedupe(rows.filter(s => s.timeOfDay === 'am')).slice(0, 4)
  const pm = dedupe(rows.filter(s => s.timeOfDay === 'pm')).slice(0, 2)
  return [...am, ...pm]
}

/** 造一张今日 CONFIRMED 订单，复刻真实确认副作用（扣库存），带标记 */
async function makeOrder(
  operatorId: string, operatorName: string, seq: number,
  cust: { id: string; name: string }, chosen: Array<Prod & { qty: number }>, slotId: string | null,
): Promise<void> {
  const id = randomUUID()
  const code = `${CODE_PREFIX}${String(seq).padStart(4, '0')}`
  const pay: 'CASH' | 'ONLINE' = rng() < 0.5 ? 'CASH' : 'ONLINE'
  let total = 0
  const lineData = chosen.map((p, idx) => {
    const subtotal = round2(p.sell * p.qty)
    total += subtotal
    return {
      productId: p.id, productName: p.name, uomId: p.uomId, uomName: p.uomName,
      unitPrice: p.sell, taxRate: p.taxRate, orderedQty: p.qty, deliveredQty: 0, invoicedQty: 0,
      subtotal, sequence: idx,
    }
  })
  total = round2(total)
  const items = chosen.map((p, idx) => ({ productId: p.id, productName: p.name, spec: '', price: p.sell, quantity: p.qty, subtotal: lineData[idx].subtotal }))
  const day = dayStartUTC()

  await prisma.$transaction([
    prisma.order.create({
      data: {
        id, code, createdById: operatorId, createdByName: operatorName,
        restaurantId: cust.id, restaurantName: cust.name, items, totalAmount: total,
        status: 'CONFIRMED', paymentMethod: pay, externalRef: SHORTAGE_REF, priceType: 'multi',
        commissionRate: 0.03, driverSlotId: slotId,
        quotationDate: day, confirmationDate: todayAt(9), deliveryDate: day, createdAt: todayAt(8),
        lines: { create: lineData },
      },
    }),
    prisma.deliverySlip.create({ data: { orderId: id, customerId: cust.id, customerName: cust.name, deliveryDate: day, createdAt: todayAt(9) } }),
    prisma.orderAuditLog.create({ data: { orderId: id, userId: operatorId, action: 'confirmed', totalAfter: total, createdAt: todayAt(9) } }),
    prisma.stockMove.createMany({
      data: chosen.map(p => ({ productId: p.id, productName: p.name, type: 'OUT' as const, qty: -round3(p.qty), note: `${SHORTAGE_REF} 确认出库 ${code}`, sourceType: 'SO', sourceId: id, sourceRef: code, movedAt: todayAt(9) })),
    }),
  ])
}

async function main(): Promise<void> {
  const cleanOnly = process.argv.includes('--clean')
  console.log(cleanOnly ? '🧹 清理缺货处理演示数据...' : '📦 缺货处理演示补种启动...')

  const removed = await cleanupOwn()
  if (removed > 0) console.log(`   已清理旧演示单 ${removed} 张`)
  if (cleanOnly) {
    console.log('✅ 演示数据已清空（未重建）')
    await prisma.$disconnect()
    return
  }

  const operator = await prisma.user.findFirst({ where: { OR: [{ role: 'OPERATOR' }, { roles: { has: 'OPERATOR' } }] }, select: { id: true, name: true } })
  if (!operator) throw new Error('缺少 OPERATOR 用户')
  const operatorName = operator.name ?? 'Operator'

  const products = await loadProducts()
  if (products.length < DEMO_PRODUCT_COUNT + 5) throw new Error('可用商品不足')
  const demoProducts = products.slice(0, DEMO_PRODUCT_COUNT)
  const otherProducts = products.slice(DEMO_PRODUCT_COUNT)

  const slots = await loadDriverSlots()
  if (slots.length === 0) throw new Error('没有 active 司机槽位')

  const customers = await prisma.customer.findMany({
    where: { isCustomer: true, isActive: true, isVendor: false },
    select: { id: true, name: true }, orderBy: { createdAt: 'asc' }, take: ORDER_COUNT,
  })
  if (customers.length < ORDER_COUNT) throw new Error(`客户不足（需要 ${ORDER_COUNT}，实际 ${customers.length}）`)

  let seq = 1
  const demoHitCount = new Map<string, number>()
  for (let i = 0; i < customers.length; i++) {
    const cust = customers[i]
    // 司机分配：前面的单轮流分到真实槽位（覆盖 AM/PM），末尾 2 单留「待分配」演示空槽位
    const slotId = i >= customers.length - 2 ? null : slots[i % slots.length].id

    let chosen: Array<Prod & { qty: number }>
    if (i === 0) {
      // golden-path：第一单固定含全部演示品、整数量，便于手工核对总额
      chosen = demoProducts.map(p => ({ ...p, qty: 10 }))
    } else {
      // 80/20：多数订单命中 1~2 个演示品 + 2~4 个长尾商品
      const demoPick = rShuffle(demoProducts).slice(0, rInt(1, 2))
      const extraPick = rShuffle(otherProducts).slice(0, rInt(2, 4))
      chosen = [...demoPick, ...extraPick].map(p => ({ ...p, qty: rInt(2, 15) }))
    }
    for (const p of chosen) if (demoProducts.some(d => d.id === p.id)) demoHitCount.set(p.name, (demoHitCount.get(p.name) ?? 0) + 1)
    await makeOrder(operator.id, operatorName, seq++, cust, chosen, slotId)
  }

  console.log('🧮 补足期初库存 + 重算库存（守恒）...')
  const topped = await ensureNonNegativeStock(prisma, new Date(dayStartUTC().getTime() - 30 * 86_400_000))
  if (topped > 0) console.log(`   期初补足 ${topped} 个商品（避免卖超负库存）`)
  await recomputeOnHand(prisma)

  const slotDesc = slots.map(s => `${s.timeOfDay.toUpperCase()}·${s.driverName}`).join(', ')
  console.log('\n✅ 缺货处理演示数据就绪')
  console.log(`   订单：${customers.length} 张（今日配送 · CONFIRMED · 标记 externalRef=${SHORTAGE_REF}）`)
  console.log(`   司机覆盖：${slotDesc}（末 2 单为「待分配」）`)
  console.log('   缺货演示品（在缺货处理页搜这几个，会看到成批订单行）：')
  for (const p of demoProducts) console.log(`     · ${p.name}  —— 命中 ${demoHitCount.get(p.name) ?? 0} 张订单`)
  console.log(`\n   一键回滚： npm run db:seed:shortage-demo -- --clean`)

  await prisma.$disconnect()
}
main().catch(e => { console.error(e); process.exit(1) })
