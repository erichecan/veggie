/**
 * 会计核销页「钱」板块：以司机在手机端填写的站点实收为入账来源，
 * 订单金额只作核对参考。确认粒度仍为「司机 × 送货日」。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { round2, toNum } from '@/lib/decimal-helpers'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { driverNameFromOrder } from '@/lib/driver-slot'
import { businessDayRange, toDayKey } from '@/lib/analytics/metrics'
import { RETURNS_FLOOR_DATE, RETURNED_STAY_HOURS } from '@/lib/accounting/returns-constants'

export const CASH_ORDER_STATUSES = ['IN_DELIVERY', 'COMPLETED', 'LOCKED'] as const

export interface DriverCashGroup {
  businessDate: string
  driverName: string
  /** 司机在手机端报告的实际现金 */
  cashTotal: number
  /** 司机在手机端报告的实际银行/在线收款 */
  transferTotal: number
  total: number
  /** 订单金额参考值；不作为实际收款入账 */
  expectedTotal: number
  /** 尚无完整司机回单报告的订单数 */
  unreportedOrderCount: number
  orderCount: number
  confirmed: boolean
  confirmedAt: string | null
  confirmedByName: string | null
  lateOrderCount: number
  lateAmount: number
  daysAgo: number
}

export interface DriverCashCollection {
  restaurantId: string
  restaurantName: string
  amount: number
  method: 'cash' | 'transfer'
  orderIds: string[]
}

export interface DriverCashPostingData {
  orderIds: string[]
  cashTotal: number
  transferTotal: number
  expectedTotal: number
  unreportedOrderCount: number
  collections: DriverCashCollection[]
}

function dayDiff(fromDay: string, toDay: string): number {
  return Math.max(0, Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000))
}

type ReportStop = {
  restaurantId: string
  restaurantName?: string
  orderIds?: string[]
  delivered?: boolean
  returns?: unknown[]
  payment?: number | null
  paymentMethod?: 'CASH' | 'ONLINE' | null
}

function reportStops(value: unknown): ReportStop[] {
  return Array.isArray(value) ? value as ReportStop[] : []
}

function deliveredOrderTotal(lines: Array<{ deliveredQty: unknown; unitPrice: unknown; taxRate: unknown }>): number {
  return round2(lines.reduce((sum, line) => {
    const qty = toNum(line.deliveredQty)
    const unit = toNum(line.unitPrice)
    const rawTax = toNum(line.taxRate)
    const rate = rawTax > 1 ? rawTax / 100 : rawTax
    return sum + qty * unit * (1 + rate)
  }, 0))
}

async function orderCandidates(businessDate: string) {
  const at = new Date(`${businessDate}T00:00:00`)
  const { start, end } = businessDayRange(at)
  const orders = await prisma.order.findMany({
    where: { status: { in: [...CASH_ORDER_STATUSES] }, deliveryDate: { gte: start, lt: end } },
    select: {
      id: true, deliveryDate: true, paymentMethod: true, restaurantId: true, restaurantName: true,
      driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      lines: { select: { deliveredQty: true, unitPrice: true, taxRate: true } },
    },
  })
  const withDriver = await attachWaveDisplay(serializeApi(orders) as Array<typeof orders[number] & { deliveryBatchDisplay?: string | null }>)
  return { start, end, orders: withDriver }
}

/**
 * Build the posting snapshot from completed customer stops in the driver's trip report.
 * Legacy reports without a stored method can be inferred only when all linked orders have
 * the same payment method; mixed stops must be corrected by the driver before accounting confirms.
 */
export async function getDriverCashPostingData(driverName: string, businessDate: string): Promise<DriverCashPostingData> {
  const [candidateData, confirmations] = await Promise.all([
    orderCandidates(businessDate),
    prisma.driverCashConfirmation.findMany({ where: { businessDate }, select: { orderIds: true } }),
  ])
  const priorIds = new Set(confirmations.flatMap(c => c.orderIds))
  const mine = candidateData.orders.filter(order => driverNameFromOrder(order as never) === driverName && !priorIds.has(order.id))
  const byId = new Map(mine.map(order => [order.id, order]))
  const orderIds = mine.map(order => order.id)

  if (mine.length === 0) return { orderIds: [], cashTotal: 0, transferTotal: 0, expectedTotal: 0, unreportedOrderCount: 0, collections: [] }

  // Trip creation can straddle a UTC date boundary while the delivery date is stored as a
  // business date. Search a one-day margin and use the exact order ids to attach each stop.
  const tripFrom = new Date(candidateData.start.getTime() - 86_400_000)
  const tripTo = new Date(candidateData.end.getTime() + 86_400_000)
  const trips = await prisma.trip.findMany({
    where: { createdAt: { gte: tripFrom, lt: tripTo } },
    select: { driverName: true, status: true, restaurants: true },
  })

  const covered = new Set<string>()
  const collectionsByKey = new Map<string, DriverCashCollection>()
  for (const trip of trips) {
    for (const stop of reportStops(trip.restaurants)) {
      const linked = (stop.orderIds ?? []).filter(id => byId.has(id) && !covered.has(id))
      if (!linked.length) continue
      const completed = String(trip.status).toUpperCase() === 'COMPLETED' || stop.delivered === true || (Array.isArray(stop.returns) && stop.returns.length > 0)
      if (!completed || (trip.driverName && trip.driverName !== driverName)) continue

      const amount = Number(stop.payment)
      if (!Number.isFinite(amount) || amount < 0) continue
      let method = stop.paymentMethod
      if (!method) {
        const legacyMethods = new Set(linked.map(id => String(byId.get(id)?.paymentMethod ?? '').toUpperCase()))
        if (legacyMethods.size === 1) {
          const inferred = [...legacyMethods][0]
          if (inferred === 'CASH' || inferred === 'ONLINE') method = inferred
        }
      }
      if (amount > 0 && method !== 'CASH' && method !== 'ONLINE') continue

      linked.forEach(id => covered.add(id))
      if (amount <= 0) continue
      const key = `${stop.restaurantId}|${method}`
      const current = collectionsByKey.get(key) ?? {
        restaurantId: stop.restaurantId,
        restaurantName: stop.restaurantName ?? byId.get(linked[0])?.restaurantName ?? '',
        amount: 0,
        method: method === 'CASH' ? 'cash' : 'transfer',
        orderIds: [],
      }
      current.amount = round2(current.amount + amount)
      current.orderIds = [...new Set([...current.orderIds, ...linked])]
      collectionsByKey.set(key, current)
    }
  }

  const cashTotal = round2([...collectionsByKey.values()].filter(c => c.method === 'cash').reduce((sum, c) => sum + c.amount, 0))
  const transferTotal = round2([...collectionsByKey.values()].filter(c => c.method === 'transfer').reduce((sum, c) => sum + c.amount, 0))
  const expectedTotal = round2(mine.reduce((sum, order) => sum + deliveredOrderTotal(order.lines ?? []), 0))
  return {
    orderIds,
    cashTotal,
    transferTotal,
    expectedTotal,
    unreportedOrderCount: Math.max(0, mine.length - covered.size),
    collections: [...collectionsByKey.values()],
  }
}

export async function listDriverCash(opts: { from?: string | null; to?: string | null } = {}, now = new Date()) {
  const today = toDayKey(now)
  const floor = new Date(`${RETURNS_FLOOR_DATE}T00:00:00Z`)
  const range: Record<string, Date> = { gte: floor }
  if (opts.from) { const d = new Date(`${opts.from}T00:00:00Z`); if (d > floor) range.gte = d }
  if (opts.to) range.lt = new Date(Date.parse(`${opts.to}T00:00:00Z`) + 86_400_000)

  const confirmations = await prisma.driverCashConfirmation.findMany({
    where: { businessDate: { gte: RETURNS_FLOOR_DATE } },
    select: { driverName: true, businessDate: true, cashTotal: true, transferTotal: true, orderIds: true, confirmedAt: true, confirmedByName: true },
  })
  const confirmedOrderIds = new Set(confirmations.flatMap(c => c.orderIds))
  const confirmationByKey = new Map(confirmations.map(c => [`${c.businessDate}|${c.driverName}`, c]))
  const candidateRows = await prisma.order.findMany({ where: { status: { in: [...CASH_ORDER_STATUSES] }, deliveryDate: range }, select: { id: true } })
  const openIds = candidateRows.map(row => row.id).filter(id => !confirmedOrderIds.has(id))
  const orders = []
  for (let i = 0; i < openIds.length; i += 1000) {
    orders.push(...await prisma.order.findMany({
      where: { id: { in: openIds.slice(i, i + 1000) } },
      select: { id: true, deliveryDate: true, paymentMethod: true, restaurantId: true, restaurantName: true, driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } }, lines: { select: { deliveredQty: true, unitPrice: true, taxRate: true } } },
    }))
  }
  const withDriver = await attachWaveDisplay(serializeApi(orders) as Array<typeof orders[number] & { deliveryBatchDisplay?: string | null }>)
  const grouped = new Map<string, { businessDate: string; driverName: string; expected: number; count: number; orders: typeof withDriver }>()
  for (const order of withDriver) {
    const driver = driverNameFromOrder(order as never)
    if (!driver || !order.deliveryDate) continue
    const businessDate = String(order.deliveryDate).slice(0, 10)
    const key = `${businessDate}|${driver}`
    const group = grouped.get(key) ?? { businessDate, driverName: driver, expected: 0, count: 0, orders: [] }
    group.expected += deliveredOrderTotal(order.lines ?? [])
    group.count += 1
    group.orders.push(order)
    grouped.set(key, group)
  }

  const reportByKey = new Map<string, DriverCashPostingData>()
  await Promise.all([...grouped.values()].map(async group => {
    reportByKey.set(`${group.businessDate}|${group.driverName}`, await getDriverCashPostingData(group.driverName, group.businessDate))
  }))

  const out: DriverCashGroup[] = []
  for (const [key, g] of grouped) {
    const confirmation = confirmationByKey.get(key)
    const report = reportByKey.get(key)!
    out.push({
      businessDate: g.businessDate, driverName: g.driverName,
      cashTotal: confirmation ? round2(Number(confirmation.cashTotal)) : report.cashTotal,
      transferTotal: confirmation ? round2(Number(confirmation.transferTotal)) : report.transferTotal,
      total: confirmation ? round2(Number(confirmation.cashTotal) + Number(confirmation.transferTotal)) : round2(report.cashTotal + report.transferTotal),
      expectedTotal: confirmation ? round2(Number(confirmation.cashTotal) + Number(confirmation.transferTotal)) : g.expected,
      unreportedOrderCount: confirmation ? 0 : report.unreportedOrderCount,
      orderCount: confirmation ? confirmation.orderIds.length : g.count,
      confirmed: !!confirmation,
      confirmedAt: confirmation?.confirmedAt.toISOString() ?? null,
      confirmedByName: confirmation?.confirmedByName ?? null,
      lateOrderCount: confirmation ? g.count : 0,
      lateAmount: confirmation ? g.expected : 0,
      daysAgo: dayDiff(g.businessDate, today),
    })
  }

  const stayFrom = now.getTime() - RETURNED_STAY_HOURS * 3_600_000
  for (const confirmation of confirmations) {
    const key = `${confirmation.businessDate}|${confirmation.driverName}`
    if (grouped.has(key) || confirmation.confirmedAt.getTime() < stayFrom) continue
    if (opts.from && confirmation.businessDate < opts.from) continue
    if (opts.to && confirmation.businessDate > opts.to) continue
    out.push({
      businessDate: confirmation.businessDate, driverName: confirmation.driverName,
      cashTotal: round2(Number(confirmation.cashTotal)), transferTotal: round2(Number(confirmation.transferTotal)),
      total: round2(Number(confirmation.cashTotal) + Number(confirmation.transferTotal)),
      expectedTotal: round2(Number(confirmation.cashTotal) + Number(confirmation.transferTotal)),
      unreportedOrderCount: 0, orderCount: confirmation.orderIds.length,
      confirmed: true, confirmedAt: confirmation.confirmedAt.toISOString(), confirmedByName: confirmation.confirmedByName,
      lateOrderCount: 0, lateAmount: 0, daysAgo: dayDiff(confirmation.businessDate, today),
    })
  }
  out.sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.driverName.localeCompare(b.driverName, 'zh-CN'))
  const pending = out.filter(group => !group.confirmed)
  const summary = {
    pendingGroups: pending.length,
    pendingCash: round2(pending.reduce((sum, group) => sum + group.cashTotal, 0)),
    pendingTransfer: round2(pending.reduce((sum, group) => sum + group.transferTotal, 0)),
    oldestDays: pending.reduce((max, group) => Math.max(max, group.daysAgo), 0),
    lateGroups: out.filter(group => group.lateOrderCount > 0).length,
    unreportedOrders: pending.reduce((sum, group) => sum + group.unreportedOrderCount, 0),
  }
  return { businessDate: today, groups: out, summary }
}
