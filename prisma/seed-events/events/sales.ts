/**
 * 销售链事件：下单 → 确认(扣库存+FIFO Lot) → 波次 → 行程送达
 * ============================================================================
 * 严格对齐真实代码副作用（docs/codebase/03 §5）：库存在「确认」时扣，
 * 配送完成只回写 deliveredQty、不再动库存。
 */
import { randomUUID } from 'crypto'
import type { Prisma } from '../../../lib/generated/prisma/client'
import { MARK, round2, round3, DAY, type Ctx, type Persona, type ProductInfo } from '../shared'

export type Stage =
  | 'PENDING'
  | 'CONFIRMED'
  | 'WAVE_ASSIGNED'
  | 'IN_DELIVERY'
  | 'COMPLETED'
  | 'CANCELLED'

interface LineSpec {
  product: ProductInfo
  qty: number
}

export interface MadeOrder {
  id: string
  code: string
  persona: Persona
  date: Date
  total: number
  paymentMethod: 'CASH' | 'ONLINE'
  stage: Stage
  specs: LineSpec[]
}

const localDay = (d: Date): string =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`

function stageFor(daysAgo: number, rng: Ctx['rng']): Stage {
  if (rng.chance(0.04)) return 'CANCELLED'
  if (daysAgo < 2) return 'PENDING'
  if (daysAgo < 3) return 'CONFIRMED'
  if (daysAgo < 5) return 'WAVE_ASSIGNED'
  if (daysAgo < 8) return 'IN_DELIVERY'
  return 'COMPLETED'
}

function buildSpecs(ctx: Ctx, persona: Persona): LineSpec[] {
  const n = ctx.rng.int(persona.linesPerOrder[0], persona.linesPerOrder[1])
  const chosen = ctx.rng.pickN(persona.basket, Math.min(n, persona.basket.length))
  return chosen.map((product) => ({ product, qty: ctx.rng.int(2, 14) }))
}

/** 下单：Order(PENDING) + OrderLine + items 快照 + 审计日志 */
async function placeOrder(ctx: Ctx, persona: Persona, date: Date, specs: LineSpec[]): Promise<MadeOrder> {
  const paymentMethod: 'CASH' | 'ONLINE' = persona.paymentTerm === 'cash' ? 'CASH' : 'ONLINE'
  let total = 0
  const lineData = specs.map((s, idx) => {
    const subtotal = round2(s.product.sellPrice * s.qty)
    total += subtotal
    return {
      productId: s.product.id,
      productName: s.product.name,
      spec: null,
      note: null,
      uomId: s.product.uomId,
      uomName: s.product.uomName,
      unitPrice: s.product.sellPrice,
      taxRate: s.product.taxRate,
      orderedQty: s.qty,
      deliveredQty: 0,
      invoicedQty: 0,
      subtotal,
      sequence: idx,
    }
  })
  total = round2(total)
  const items = specs.map((s) => ({
    productId: s.product.id,
    productName: s.product.name,
    spec: '',
    price: s.product.sellPrice,
    quantity: s.qty,
    subtotal: round2(s.product.sellPrice * s.qty),
  }))
  // 全局自增保证唯一（EVT-SO- 前缀避免与真实 code 撞）；预生成 id 让审计日志同批写
  const orderCode = `EVT-SO-${String(++ctx._orderSeq).padStart(6, '0')}`
  const orderId = randomUUID()
  await ctx.prisma.$transaction([
    ctx.prisma.order.create({
      data: {
        id: orderId,
        code: orderCode,
        createdById: ctx.operatorId,
        createdByName: ctx.operatorName,
        restaurantId: persona.id,
        restaurantName: persona.name,
        items,
        totalAmount: total,
        status: 'PENDING',
        paymentMethod,
        // 唯一列上不能放共享标记：Order.externalRef 有唯一约束，
        // 直接写 MARK.orderRef 会让第 2 张单就撞 P2002。前缀保留标记语义。
        externalRef: `${MARK.orderRef}-${orderId}`,
        priceType: 'multi',
        commissionRate: persona.commissionRate,
        salesUserId: ctx.salesUserIdByName[persona.salesman] ?? null,
        driverSlotId: persona.driverSlotId,
        quotationDate: date,
        createdAt: date,
        lines: { create: lineData },
      },
    }),
    ctx.prisma.orderAuditLog.create({
      data: { orderId, userId: ctx.operatorId, action: 'created', totalAfter: total, createdAt: date },
    }),
  ])
  return { id: orderId, code: orderCode, persona, date, total, paymentMethod, stage: 'PENDING', specs }
}

/**
 * 确认：CONFIRMED + DeliverySlip + 扣库存 + 审计
 * 与真实代码一致（orders/[id]/route.ts:459-484）：每 PRODUCT 行一条 OUT 流水 +
 * 扣 qtyOnHand，允许负库存；不做逐 Lot 消耗（app 本身也不做，且批量写更快）。
 */
async function confirmOrder(ctx: Ctx, o: MadeOrder, date: Date): Promise<void> {
  // 4 个互不依赖的写操作用 $transaction 数组合并为一次往返（降低 EU 网络延迟开销）。
  // 仅写流水；qtyOnHand 末尾由 recomputeOnHand 统一从流水汇总（见 inventory.ts）。
  await ctx.prisma.$transaction([
    ctx.prisma.order.update({
      where: { id: o.id },
      data: { status: 'CONFIRMED', confirmationDate: date, deliveryDate: date },
    }),
    ctx.prisma.deliverySlip.create({
      data: { orderId: o.id, customerId: o.persona.id, customerName: o.persona.name, deliveryDate: date, createdAt: date },
    }),
    ctx.prisma.orderAuditLog.create({
      data: { orderId: o.id, userId: ctx.operatorId, action: 'confirmed', totalAfter: o.total, createdAt: date },
    }),
    ctx.prisma.stockMove.createMany({
      data: o.specs.map((s) => ({
        productId: s.product.id,
        productName: s.product.name,
        type: 'OUT' as const,
        qty: -round3(s.qty),
        note: `${MARK.stockNote} 确认出库 ${o.code}`,
        sourceType: 'SO',
        sourceId: o.id,
        sourceRef: o.code,
        movedAt: date,
      })),
    }),
  ])
}

async function cancelOrder(ctx: Ctx, o: MadeOrder): Promise<void> {
  await ctx.prisma.order.update({ where: { id: o.id }, data: { status: 'CANCELLED' } })
  await ctx.prisma.orderAuditLog.create({
    data: { orderId: o.id, userId: ctx.operatorId, action: 'cancelled', createdAt: o.date },
  })
}

/** 一组订单组波次：Order→WAVE_ASSIGNED + PickingWave(SORTED) */
async function makeWave(
  ctx: Ctx,
  group: MadeOrder[],
  day: Date,
  driverSlotId: string | null,
  driverName: string | null,
): Promise<void> {
  // 确定性命名（重置后波次表已空，无需查询发号）；(waveDate,driverSlotId) 唯一已由分桶保证
  const ids = group.map((o) => o.id)
  const name = `${MARK.wavePrefix}${localDay(day)} ${driverName ?? ''}`.trim()
  await ctx.prisma.$transaction([
    ctx.prisma.pickingWave.create({
      data: {
        name,
        orderIds: ids,
        status: 'SORTED',
        waveDate: new Date(localDay(day) + 'T00:00:00Z'),
        driverSlotId: driverSlotId ?? undefined,
        driverName: driverName ?? undefined,
        createdAt: day,
      },
    }),
    ctx.prisma.order.updateMany({ where: { id: { in: ids } }, data: { status: 'WAVE_ASSIGNED' } }),
  ])
}

/** 装车配送：Trip + 订单状态推进 + deliveredQty 回写 + 司机交账 */
async function makeTrip(
  ctx: Ctx,
  group: MadeOrder[],
  day: Date,
  driverName: string | null,
  complete: boolean,
): Promise<void> {
  const totalPayment = round2(group.reduce((a, o) => a + o.total, 0))
  const commission = round2(group.reduce((a, o) => a + o.total * o.persona.commissionRate, 0))
  const cash = round2(group.filter((o) => o.paymentMethod === 'CASH').reduce((a, o) => a + o.total, 0))
  const online = round2(totalPayment - cash)
  const timeSlot = ctx.rng.chance(0.5) ? 'AM' : 'PM'
  const ids = group.map((o) => o.id)
  const ops: Prisma.PrismaPromise<unknown>[] = [
    ctx.prisma.order.updateMany({ where: { id: { in: ids } }, data: { status: 'IN_DELIVERY' } }),
  ]
  if (complete) {
    // 回写 deliveredQty = orderedQty（整组一条 SQL），订单转 COMPLETED
    ops.push(
      ctx.prisma.$executeRawUnsafe(
        `UPDATE "OrderLine" SET "deliveredQty" = "orderedQty" WHERE "orderId" = ANY($1::text[])`,
        ids,
      ),
    )
    ops.push(ctx.prisma.order.updateMany({ where: { id: { in: ids } }, data: { status: 'COMPLETED', orderReturn: true } }))
  }
  ops.push(
    ctx.prisma.trip.create({
      data: {
        name: `${MARK.tripPrefix}${timeSlot} · ${driverName ?? '司机'} · ${group.length}家`,
        timeSlot,
        driverId: ctx.driverUserId ?? undefined,
        driverName: driverName ?? undefined,
        departTime: timeSlot === 'AM' ? '08:30' : '14:00',
        status: complete ? 'COMPLETED' : 'IN_PROGRESS',
        restaurants: group.map((o) => ({
          orderId: o.id,
          customerId: o.persona.id,
          customerName: o.persona.name,
          amount: o.total,
          paymentMethod: o.paymentMethod,
        })),
        totalPayment,
        driverCommission: commission,
        cashCollected: complete ? cash : 0,
        onlineCollected: complete ? online : 0,
        settlementStatus: complete ? 'confirmed' : 'pending',
        settledAt: complete ? day : null,
        settledBy: complete ? ctx.operatorName : null,
        createdAt: day,
      },
    }),
  )
  await ctx.prisma.$transaction(ops)
}

/**
 * 主流程：按时间线为每个客户生成订单并推进到对应状态，
 * 再把 ≥WAVE_ASSIGNED 的订单按 (日, 司机批次) 组波次/行程。
 * 返回全部订单（含各状态）；调用方按 stage 过滤 COMPLETED 供开票。
 */
export async function runSales(ctx: Ctx): Promise<MadeOrder[]> {
  const spanDays = ctx.scale.monthsBack * 30
  const all: MadeOrder[] = []

  for (const persona of ctx.personas) {
    const target = Math.min(persona.ordersPerMonth * ctx.scale.monthsBack, ctx.scale.maxOrdersPerCustomer)
    for (let i = 0; i < target; i++) {
      const daysAgo = Math.max(0, Math.round(((target - 1 - i) / Math.max(1, target - 1)) * spanDays) + ctx.rng.int(-1, 1))
      const date = new Date(ctx.now.getTime() - daysAgo * DAY)
      date.setHours(9 + ctx.rng.int(0, 8), ctx.rng.int(0, 59), 0, 0)
      const specs = buildSpecs(ctx, persona)
      if (specs.length === 0) continue
      const stage = stageFor(daysAgo, ctx.rng)
      const o = await placeOrder(ctx, persona, date, specs)
      o.stage = stage
      if (stage === 'CANCELLED') {
        await cancelOrder(ctx, o)
        all.push(o)
        continue
      }
      // PENDING 之后的阶段都要先确认（扣库存）
      if (stage !== 'PENDING') {
        await confirmOrder(ctx, o, new Date(date.getTime() + DAY))
      }
      all.push(o)
    }
  }

  // 组波次 + 行程：按 (localDay of deliveryDate≈date+1, driverSlot)
  const groupable = all.filter((o) => ['WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'].includes(o.stage))
  const buckets = new Map<string, MadeOrder[]>()
  for (const o of groupable) {
    const day = new Date(o.date.getTime() + DAY)
    const key = `${localDay(day)}|${o.persona.driverSlotId ?? 'none'}`
    if (!buckets.has(key)) buckets.set(key, [])
    buckets.get(key)!.push(o)
  }
  for (const [key, group] of buckets) {
    const day = new Date(key.split('|')[0] + 'T10:00:00')
    const driverName = group[0].persona.driverName
    const driverSlotId = group[0].persona.driverSlotId
    await makeWave(ctx, group, day, driverSlotId, driverName)
    const toDeliver = group.filter((o) => o.stage === 'IN_DELIVERY' || o.stage === 'COMPLETED')
    if (toDeliver.length > 0) {
      const completed = toDeliver.filter((o) => o.stage === 'COMPLETED')
      const inDelivery = toDeliver.filter((o) => o.stage === 'IN_DELIVERY')
      if (completed.length > 0) await makeTrip(ctx, completed, day, driverName, true)
      if (inDelivery.length > 0) await makeTrip(ctx, inDelivery, day, driverName, false)
    }
  }

  return all
}
