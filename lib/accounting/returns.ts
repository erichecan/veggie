/**
 * 回单核销清单 —— 20261021 核销管理页改造（客户：「列表要一直在，看得出还有多少单没回来核销」）
 * ============================================================================
 * 范围：货已经离仓的单（配送中 / 已完成 / 已锁定），送货日期在新系统正式出车之后（RETURNS_FLOOR_DATE）——
 * Odoo 导入的历史单在这之前，不算「没回」。已确认 / 已排波次的单还没出仓，不在核销范围里。
 *
 * 两个 tab：
 *   open      待核销：未回 + 有问题，外加 24 小时内刚核销的（让会计看到刚处理过的结果）；
 *   returned  已核销：全部已核销的单，可按送货日期 / 司机 / 关键字查。
 *
 * 司机 / 上午下午取自波次归属（attachWaveDisplay），没进过波次的退回下单时选的 DriverSlot。
 */
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { formatDriverSlotFromOrder, parseDriverSlotKey } from '@/lib/driver-slot'
import { toDayKey } from '@/lib/analytics/metrics'

import { RETURNS_FLOOR_DATE, RETURNED_STAY_HOURS } from '@/lib/accounting/returns-constants'

export { RETURNS_FLOOR_DATE, RETURNED_STAY_HOURS }
export const SHIPPED_ORDER_STATUSES = ['IN_DELIVERY', 'COMPLETED', 'LOCKED'] as const

export type ReturnTab = 'open' | 'returned'
export type ReturnState = 'PENDING' | 'ISSUE' | 'RETURNED'

export interface ReturnRow {
  id: string
  code: string | null
  deliveryDate: string | null
  restaurantName: string
  paymentMethod: string
  orderStatus: string
  returnStatus: ReturnState
  returnIssueNote: string | null
  returnConfirmedAt: string | null
  returnConfirmedBy: string | null
  batch: string
  driver: string
  timeOfDay: string
  amount: number
  daysOut: number
}

export interface ReturnQuery {
  tab: ReturnTab
  from?: string | null
  to?: string | null
  driver?: string | null
  timeOfDay?: string | null
  payment?: string | null
  status?: ReturnState[] | null
  q?: string | null
}

function dayDiff(fromDay: string, toDay: string): number {
  return Math.max(0, Math.round((Date.parse(`${toDay}T00:00:00Z`) - Date.parse(`${fromDay}T00:00:00Z`)) / 86_400_000))
}

export async function listReturns(query: ReturnQuery, now = new Date()) {
  const stayFrom = new Date(now.getTime() - RETURNED_STAY_HOURS * 3_600_000)
  const floor = new Date(`${RETURNS_FLOOR_DATE}T00:00:00Z`)
  const range: Record<string, Date> = { gte: floor }
  if (query.from) {
    const d = new Date(`${query.from}T00:00:00Z`)
    if (d > floor) range.gte = d
  }
  if (query.to) range.lt = new Date(Date.parse(`${query.to}T00:00:00Z`) + 86_400_000)

  const tabWhere = query.tab === 'returned'
    ? { returnStatus: 'RETURNED' as const }
    : { OR: [
        { returnStatus: { in: ['PENDING', 'ISSUE'] as ReturnState[] } },
        { returnStatus: 'RETURNED' as const, returnConfirmedAt: { gte: stayFrom } },
      ] }
  const text = query.q?.trim()

  const orders = await prisma.order.findMany({
    where: {
      status: { in: [...SHIPPED_ORDER_STATUSES] },
      deliveryDate: range,
      ...(query.payment ? { paymentMethod: query.payment as never } : {}),
      AND: [
        tabWhere,
        ...(text ? [{ OR: [
          { code: { contains: text, mode: 'insensitive' as const } },
          { restaurantName: { contains: text, mode: 'insensitive' as const } },
        ] }] : []),
      ],
    },
    select: {
      id: true, code: true, deliveryDate: true, restaurantName: true, paymentMethod: true, status: true,
      returnStatus: true, returnIssueNote: true, returnConfirmedAt: true, returnConfirmedBy: true,
      driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
      lines: { select: { subtotal: true, taxRate: true } },
    },
    orderBy: [{ deliveryDate: 'asc' }, { code: 'asc' }],
  })

  const today = toDayKey(now)
  const rows: ReturnRow[] = (await attachWaveDisplay(serializeApi(orders) as Array<typeof orders[number] & { id: string; deliveryBatchDisplay?: string | null }>))
    .map(o => {
      const batch = formatDriverSlotFromOrder(o as never)
      const slot = parseDriverSlotKey(batch)
      const day = o.deliveryDate ? String(o.deliveryDate).slice(0, 10) : null
      return {
        id: o.id,
        code: o.code,
        deliveryDate: day,
        restaurantName: o.restaurantName,
        paymentMethod: String(o.paymentMethod),
        orderStatus: String(o.status),
        returnStatus: String(o.returnStatus) as ReturnState,
        returnIssueNote: o.returnIssueNote ?? null,
        returnConfirmedAt: o.returnConfirmedAt ? String(o.returnConfirmedAt) : null,
        returnConfirmedBy: o.returnConfirmedBy ?? null,
        batch,
        driver: slot.driver,
        timeOfDay: slot.time,
        amount: round2(orderIncTaxTotal((o.lines ?? []) as never)),
        daysOut: day ? dayDiff(day, today) : 0,
      }
    })

  const filtered = rows.filter(r =>
    (!query.driver || r.driver === query.driver)
    && (!query.timeOfDay || r.timeOfDay === query.timeOfDay)
    && (!query.status?.length || query.status.includes(r.returnStatus)))

  // 汇总按筛选前的全量算（卡片上的「还有多少没回」不跟着下拉筛选变），按司机拆分只算没核销的
  const open = rows.filter(r => r.returnStatus !== 'RETURNED')
  const byDriver = new Map<string, { driver: string; count: number; amount: number; cash: number; oldestDays: number }>()
  for (const r of open) {
    const k = r.driver || '未分配'
    const g = byDriver.get(k) ?? { driver: k, count: 0, amount: 0, cash: 0, oldestDays: 0 }
    g.count += 1
    g.amount = round2(g.amount + r.amount)
    if (r.paymentMethod.toUpperCase() === 'CASH') g.cash = round2(g.cash + r.amount)
    g.oldestDays = Math.max(g.oldestDays, r.daysOut)
    byDriver.set(k, g)
  }
  const summary = {
    pending: rows.filter(r => r.returnStatus === 'PENDING').length,
    issue: rows.filter(r => r.returnStatus === 'ISSUE').length,
    returned: rows.filter(r => r.returnStatus === 'RETURNED').length,
    openAmount: round2(open.reduce((s, r) => s + r.amount, 0)),
    cashOpenAmount: round2(open.filter(r => r.paymentMethod.toUpperCase() === 'CASH').reduce((s, r) => s + r.amount, 0)),
    oldestDays: open.reduce((m, r) => Math.max(m, r.daysOut), 0),
    byDriver: [...byDriver.values()].sort((a, b) => b.count - a.count),
    drivers: [...new Set(rows.map(r => r.driver).filter(Boolean))].sort(),
  }
  return { today, floor: RETURNS_FLOOR_DATE, rows: filtered, summary }
}
