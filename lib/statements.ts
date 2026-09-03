/**
 * 对账单生成的可复用核心逻辑
 * ============================================================================
 * 从 `POST /api/statements` 抽出来，供该路由与 `POST /api/cron/generate-statements`
 * 共用同一份实现 —— 避免定时任务另起一份复制品，两边算法/口径不知不觉分叉。
 *
 * 幂等性：`generateStatement` 在创建前会查同客户同期间是否已有记录，已存在时
 * 返回 `{ ok: false, reason: 'duplicate', existingId }` 而不是抛错或裸插入，
 * 定时任务重复触发（补跑、误触发两次）不会生成两张账。
 */
import { prisma } from '@/lib/db'
import { toNum } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { businessDayStart, addBusinessDays, BUSINESS_TIMEZONE } from '@/lib/analytics/metrics'
import {
  resolveStatementPeriod, summarizeStatement, StatementInputError,
  type StatementOrderRow,
} from '@/lib/finance/statement'

/** 计入对账的订单状态：确认之后的都算已发生的销售（与 app/api/statements/route.ts 保持一致） */
const BILLABLE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED', 'LOCKED']

export type SettlementCycle = 'NONE' | 'WEEKLY' | 'MONTHLY'

export type GenerateStatementResult =
  | { ok: true; statement: Awaited<ReturnType<typeof prisma.statement.create>>; openingSource: 'previous-statement' | 'derived-history' }
  | { ok: false; reason: 'duplicate'; existingId: string; status: string }
  | { ok: false; reason: 'not-found' }

/**
 * 生成一张对账单。核心算法与口径说明见 lib/finance/statement.ts 文件头。
 * 不做鉴权、不写操作日志 —— 这两件事由调用方（HTTP 路由）负责，
 * 因为 cron 路由没有「操作用户」，日志格式和触发方不一样。
 */
export async function generateStatement(
  customerId: string,
  periodStart: unknown,
  periodEnd: unknown,
): Promise<GenerateStatementResult> {
  const period = resolveStatementPeriod(periodStart, periodEnd) // 校验失败抛 StatementInputError，交给调用方处理
  const { start, endExclusive, endLabel } = period

  const customer = await prisma.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } })
  if (!customer) return { ok: false, reason: 'not-found' }

  // 幂等性：同客户同期间已有一张就不再生成第二张
  const duplicate = await prisma.statement.findFirst({
    where: { customerId, periodStart: start, periodEnd: endLabel },
    select: { id: true, status: true },
  })
  if (duplicate) return { ok: false, reason: 'duplicate', existingId: duplicate.id, status: duplicate.status }

  const orderSelect = { id: true, code: true, confirmationDate: true, lines: { select: { subtotal: true, taxRate: true } } }
  const toRow = (o: { id: string; code?: string | null; confirmationDate?: Date | null; lines: Array<{ subtotal: unknown; taxRate: unknown }> }): StatementOrderRow =>
    ({ id: o.id, code: o.code ?? null, confirmationDate: o.confirmationDate ?? null, incTaxTotal: orderIncTaxTotal(o.lines) })

  const lastStatement = await prisma.statement.findFirst({
    where: { customerId, periodEnd: { lt: start } },
    orderBy: { periodEnd: 'desc' },
    select: { closingBalance: true },
  })
  let openingBalance: number
  let openingSource: 'previous-statement' | 'derived-history'
  if (lastStatement) {
    openingBalance = toNum(lastStatement.closingBalance)
    openingSource = 'previous-statement'
  } else {
    const [priorOrders, priorPayments] = await Promise.all([
      prisma.order.findMany({
        where: { restaurantId: customerId, status: { in: BILLABLE_STATUSES as never[] }, confirmationDate: { lt: start } },
        select: orderSelect,
      }),
      prisma.payment.findMany({ where: { customerId, paidAt: { lt: start } }, select: { amount: true } }),
    ])
    const priorSales = priorOrders.reduce((s, o) => s + orderIncTaxTotal(o.lines), 0)
    const priorPaid = priorPayments.reduce((s, p) => s + toNum(p.amount), 0)
    openingBalance = Math.round((priorSales - priorPaid) * 100) / 100
    openingSource = 'derived-history'
  }

  const orders = await prisma.order.findMany({
    where: { restaurantId: customerId, status: { in: BILLABLE_STATUSES as never[] }, confirmationDate: { gte: start, lt: endExclusive } },
    orderBy: { confirmationDate: 'asc' },
    select: orderSelect,
  })

  const periodPayments = await prisma.payment.findMany({
    where: { customerId, paidAt: { gte: start, lt: endExclusive } },
    orderBy: { paidAt: 'asc' },
    select: { id: true, amount: true, invoiceId: true, method: true, paidAt: true, note: true },
  })

  const summary = summarizeStatement(
    openingBalance,
    orders.map(toRow),
    periodPayments.map(p => ({ id: p.id, invoiceId: p.invoiceId, amount: toNum(p.amount), method: p.method, paidAt: p.paidAt, note: p.note })),
  )

  const statement = await prisma.statement.create({
    data: { customerId: customer.id, customerName: customer.name, periodStart: start, periodEnd: endLabel, ...summary, status: 'draft' },
  })

  return { ok: true, statement, openingSource }
}

export { StatementInputError }

/** 把 Date 拆成它在业务时区（Europe/Dublin）的 [年, 月, 日, ISO星期(1=周一..7=周日)] */
function dublinParts(at: Date): { year: number; month: number; day: number; isoWeekday: number } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: BUSINESS_TIMEZONE, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
  }).formatToParts(at)
  const g = (t: string) => parts.find((p) => p.type === t)!.value
  const weekdayMap: Record<string, number> = { Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6, Sun: 7 }
  return { year: Number(g('year')), month: Number(g('month')), day: Number(g('day')), isoWeekday: weekdayMap[g('weekday')] }
}

/**
 * 按结算周期算出"应该生成对账单的区间"—— 恒为**上一个完整周期**，不含当前进行中的
 * 那一周/月（周期没走完就出账，客户还没发生的消费/付款会被漏算，下一期期初再错位）。
 *
 * WEEKLY：上一个自然周（周一~周日）。MONTHLY：上一个自然月（1号~月末）。
 * `asOf` 默认当前时刻，测试时可传固定时间点让结果可预测。
 */
export function computeSettlementPeriod(cycle: 'WEEKLY' | 'MONTHLY', asOf: Date = new Date()): { periodStart: Date; periodEnd: Date } {
  const today = businessDayStart(asOf)
  if (cycle === 'WEEKLY') {
    const { isoWeekday } = dublinParts(today)
    const thisMonday = addBusinessDays(today, -(isoWeekday - 1))
    const lastMonday = addBusinessDays(thisMonday, -7)
    const lastSunday = addBusinessDays(thisMonday, -1)
    return { periodStart: lastMonday, periodEnd: lastSunday }
  }
  const { year, month } = dublinParts(today)
  const thisMonth1st = businessDayStart(new Date(Date.UTC(year, month - 1, 1, 12)))
  const lastMonthLastDay = addBusinessDays(thisMonth1st, -1)
  const { year: ly, month: lm } = dublinParts(lastMonthLastDay)
  const lastMonth1st = businessDayStart(new Date(Date.UTC(ly, lm - 1, 1, 12)))
  return { periodStart: lastMonth1st, periodEnd: lastMonthLastDay }
}
