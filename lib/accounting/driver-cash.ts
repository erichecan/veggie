/**
 * 会计核销页「钱」板块取数 —— 20261021 改成跨天（客户：「钱板块也改成跨天的」）
 * ============================================================================
 * 原来只按「今天」汇总每位司机的应收现金/转账，前几天没点确认的那一天就再也看不到了，钱等于悬着。
 * 现在列出：
 *   - 所有还没确认的「司机 × 送货日」（自新系统正式出车 RETURNS_FLOOR_DATE 起，不限日期）；
 *   - 24 小时内刚确认的（与「单」板块同一口径，让会计看到刚处理过的结果）。
 * 确认粒度不变：一个司机一天确认一次（DriverCashConfirmation 唯一键），确认即入账（见 confirm 路由）。
 *
 * 只算货已离仓的单（配送中 / 已完成 / 已锁定）——已确认、已排波次的单还没出车，司机手上没有这笔钱。
 * 已经算进某次确认快照（orderIds）的单不再重复计入；某天确认之后才补进来的单会单独标出来，需要人工处理。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { driverNameFromOrder } from '@/lib/driver-slot'
import { toDayKey } from '@/lib/analytics/metrics'
import { RETURNS_FLOOR_DATE, RETURNED_STAY_HOURS } from '@/lib/accounting/returns-constants'

export const CASH_ORDER_STATUSES = ['IN_DELIVERY', 'COMPLETED', 'LOCKED'] as const

export interface DriverCashGroup {
  businessDate: string
  driverName: string
  cashTotal: number
  transferTotal: number
  total: number
  orderCount: number
  confirmed: boolean
  confirmedAt: string | null
  confirmedByName: string | null
  /** 这一天已确认过、确认之后又补进来的单（唯一键挡住了二次确认，需要人工处理） */
  lateOrderCount: number
  lateAmount: number
  daysAgo: number
}

function dayDiff(fromDay: string, toDay: string): number {
  return Math.max(0, Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000))
}

export async function listDriverCash(opts: { from?: string | null; to?: string | null } = {}, now = new Date()) {
  const today = toDayKey(now)
  const floor = new Date(`${RETURNS_FLOOR_DATE}T00:00:00Z`)
  const range: Record<string, Date> = { gte: floor }
  if (opts.from) { const d = new Date(`${opts.from}T00:00:00Z`); if (d > floor) range.gte = d }
  if (opts.to) range.lt = new Date(Date.parse(`${opts.to}T00:00:00Z`) + 86_400_000)

  const confirmations = await prisma.driverCashConfirmation.findMany({
    where: { businessDate: { gte: RETURNS_FLOOR_DATE } },
    select: { id: true, driverName: true, businessDate: true, cashTotal: true, transferTotal: true, orderIds: true, confirmedAt: true, confirmedByName: true },
  })
  const confirmedOrderIds = new Set(confirmations.flatMap(c => c.orderIds))
  const confirmationByKey = new Map(confirmations.map(c => [`${c.businessDate}|${c.driverName}`, c]))

  // 先只拿 id，把已经进过确认快照的单剔掉，剩下的（通常只有这几天的）才去取明细和波次归属
  const candidates = await prisma.order.findMany({
    where: { status: { in: [...CASH_ORDER_STATUSES] }, deliveryDate: range },
    select: { id: true },
  })
  const openIds = candidates.map(o => o.id).filter(id => !confirmedOrderIds.has(id))
  const orders = []
  for (let i = 0; i < openIds.length; i += 1000) {
    orders.push(...await prisma.order.findMany({
      where: { id: { in: openIds.slice(i, i + 1000) } },
      select: {
        id: true, deliveryDate: true, paymentMethod: true,
        driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
        lines: { select: { subtotal: true, taxRate: true } },
      },
    }))
  }
  const withDriver = await attachWaveDisplay(serializeApi(orders) as Array<typeof orders[number] & { id: string; deliveryBatchDisplay?: string | null }>)

  const groups = new Map<string, { businessDate: string; driverName: string; cash: number; transfer: number; count: number }>()
  for (const o of withDriver) {
    const driverName = driverNameFromOrder(o as never)
    if (!driverName || !o.deliveryDate) continue
    const businessDate = String(o.deliveryDate).slice(0, 10)
    const key = `${businessDate}|${driverName}`
    const g = groups.get(key) ?? { businessDate, driverName, cash: 0, transfer: 0, count: 0 }
    const amount = orderIncTaxTotal((o.lines ?? []) as never)
    if (String(o.paymentMethod).toUpperCase() === 'CASH') g.cash += amount
    else g.transfer += amount
    g.count += 1
    groups.set(key, g)
  }

  const out: DriverCashGroup[] = []
  for (const [key, g] of groups) {
    const c = confirmationByKey.get(key)
    out.push({
      businessDate: g.businessDate, driverName: g.driverName,
      // 已确认过的这一天：这里的单都是确认之后补进来的，金额显示确认时的数，补进来的单另列
      cashTotal: c ? round2(Number(c.cashTotal)) : round2(g.cash),
      transferTotal: c ? round2(Number(c.transferTotal)) : round2(g.transfer),
      total: c ? round2(Number(c.cashTotal) + Number(c.transferTotal)) : round2(g.cash + g.transfer),
      orderCount: c ? c.orderIds.length : g.count,
      confirmed: !!c,
      confirmedAt: c ? c.confirmedAt.toISOString() : null,
      confirmedByName: c?.confirmedByName ?? null,
      lateOrderCount: c ? g.count : 0,
      lateAmount: c ? round2(g.cash + g.transfer) : 0,
      daysAgo: dayDiff(g.businessDate, today),
    })
  }
  // 24 小时内刚确认、之后没有补单的
  const stayFrom = now.getTime() - RETURNED_STAY_HOURS * 3_600_000
  for (const c of confirmations) {
    const key = `${c.businessDate}|${c.driverName}`
    if (groups.has(key) || c.confirmedAt.getTime() < stayFrom) continue
    if (opts.from && c.businessDate < opts.from) continue
    if (opts.to && c.businessDate > opts.to) continue
    out.push({
      businessDate: c.businessDate, driverName: c.driverName,
      cashTotal: round2(Number(c.cashTotal)), transferTotal: round2(Number(c.transferTotal)),
      total: round2(Number(c.cashTotal) + Number(c.transferTotal)), orderCount: c.orderIds.length,
      confirmed: true, confirmedAt: c.confirmedAt.toISOString(), confirmedByName: c.confirmedByName,
      lateOrderCount: 0, lateAmount: 0, daysAgo: dayDiff(c.businessDate, today),
    })
  }
  out.sort((a, b) => a.businessDate.localeCompare(b.businessDate) || a.driverName.localeCompare(b.driverName, 'zh-CN'))

  const pending = out.filter(g => !g.confirmed)
  const summary = {
    pendingGroups: pending.length,
    pendingCash: round2(pending.reduce((s, g) => s + g.cashTotal, 0)),
    pendingTransfer: round2(pending.reduce((s, g) => s + g.transferTotal, 0)),
    oldestDays: pending.reduce((m, g) => Math.max(m, g.daysAgo), 0),
    lateGroups: out.filter(g => g.lateOrderCount > 0).length,
  }
  return { businessDate: today, groups: out, summary }
}
