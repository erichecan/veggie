/**
 * 客户对账单口径（台账 G1）
 * ============================================================================
 * 按配送日期分期，列示发票、收款和已确认贷记单；期末 = 期初 + 销售 − 收款 − 贷项。
 *
 * 这一层是纯函数：算术、期间边界、核对结果全在这里，接口与页面共用同一份。
 * 「逐笔对上」不靠人肉比对，而是 `reconcileStatement()` 当场给出差额 —— 对账单
 * 最没用的失败方式就是「数字看起来挺像，没人发现差了 3 分」。
 *
 * 生成算法此前的四处错位（本轮修正，逐条都在测试里钉住）：
 *
 * ① **末日整天被切掉**：原来 `createdAt: { gte: start, lte: end }`，而 end 是
 *    `new Date('2026-08-31')` = 当日 00:00。于是 8-31 全天的单一张都不算 ——
 *    月末对账少一天，且金额看着"差不多"，最难发现。改为左闭右开到次日 00:00。
 * ② **日界按 UTC 而非业务时区**：与 D8 建立的 `businessDayStart` 同一个坑。
 * ③ **销售口径用 createdAt**，而全系统销售口径 SSOT 是 `Order.confirmationDate`
 *    （lib/analytics/metrics.ts 开头写死）。两套日期意味着对账单的"本期销售额"
 *    与数据中心的销售额对不上，客户拿两张纸来问的时候没人解释得清。
 * ④ **首张对账单期初恒为 0**：原实现只认"上一张对账单的期末"，没有上一张就当 0。
 *    可这正是本任务的场景 —— 生产库一张对账单都没有。客户明明欠着钱，第一张单
 *    却从 0 起算，期末余额直接错。改为无上期时**从历史派生**（期前销售 − 期前收款）。
 *
 * ⑤ **20261026 再改一次口径**：对账单从 confirmationDate 改成按 deliveryDate 分期——
 *    客户对"这期账"的认知是"这段时间送了多少货"，不是"系统哪天敲的确认"；
 *    二者之前就有过因导入/补录造成的偏差（见项目记忆 sales-analysis-delivery-date-basis）。
 */

import { businessDayStart, addBusinessDays } from '@/lib/analytics/metrics'
import { driverCashConfirmationMarker } from '@/lib/trip-settlement-payment'

const round2 = (n: number) => Math.round(n * 100) / 100

export interface StatementPeriod {
  /** 含 */
  start: Date
  /** 不含（末日次日 00:00） */
  endExclusive: Date
  /** 末日当天 00:00，仅用于回写 periodEnd 与显示 */
  endLabel: Date
}

export class StatementInputError extends Error {}

/**
 * 解析对账期间。输入是 `YYYY-MM-DD`（或任何可被 Date 解析的值），
 * 输出按**业务时区**的左闭右开区间 —— 末日整天包含在内。
 */
export function resolveStatementPeriod(startInput: unknown, endInput: unknown): StatementPeriod {
  const s = new Date(String(startInput))
  const e = new Date(String(endInput))
  if (isNaN(s.getTime()) || isNaN(e.getTime())) throw new StatementInputError('日期格式无效')
  const start = businessDayStart(s)
  const endLabel = businessDayStart(e)
  if (endLabel < start) throw new StatementInputError('periodStart 不能晚于 periodEnd')
  return { start, endLabel, endExclusive: addBusinessDays(endLabel, 1) }
}

export interface StatementOrderRow {
  id: string
  code?: string | null
  /** 送货日期（分期口径 SSOT，20261026 起不再用 confirmationDate） */
  deliveryDate?: Date | string | null
  /** 含税金额 */
  incTaxTotal: number
}

export interface StatementPaymentRow {
  id: string
  /// 预收款登记（无关联发票）时为 null
  invoiceId: string | null
  amount: number
  method?: string | null
  paidAt?: Date | string | null
  note?: string | null
}

export type PaymentSource = 'DRIVER_CASH' | 'MANUAL'

/**
 * 这笔钱是司机带回来的现金，还是财务手工登记的汇款？
 * 判据是 `postCollections` 写进 note 的 `DRIVER_CASH_CONFIRM:<id>` 幂等标记 ——
 * 复用它而不是新加一列：那个标记本来就必须写，再存一份就会有两处真相。
 */
export function paymentSource(note: string | null | undefined): PaymentSource {
  return typeof note === 'string' && note.includes('DRIVER_CASH_CONFIRM:') ? 'DRIVER_CASH' : 'MANUAL'
}

/** 从 note 里取出 DriverCashConfirmation id（取不到返回 null） */
export function paymentConfirmationId(note: string | null | undefined): string | null {
  const m = typeof note === 'string' ? note.match(/DRIVER_CASH_CONFIRM:([A-Za-z0-9_-]+)/) : null
  return m ? m[1] : null
}

/** 给定 confirmationId，反推它写下的标记（与落库端共用同一实现） */
export const markerForDriverCashConfirmation = driverCashConfirmationMarker

export interface StatementSummary {
  openingBalance: number
  totalSales: number
  totalPayments: number
  totalCredits: number
  closingBalance: number
  orderIds: string[]
  invoiceIds: string[]
  creditNoteIds: string[]
}

/**
 * 汇总算法集中在一处，期内明细由调用方按配送/付款/贷记单生效日期查询。
 */
export function summarizeStatement(
  openingBalance: number,
  orders: StatementOrderRow[],
  payments: StatementPaymentRow[],
  credits: Array<{ id: string; amount: number }> = [],
): StatementSummary {
  const totalSales = round2(orders.reduce((s, o) => s + Number(o.incTaxTotal || 0), 0))
  const totalPayments = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0))
  const totalCredits = round2(credits.reduce((s, c) => s + Number(c.amount || 0), 0))
  return {
    openingBalance: round2(openingBalance),
    totalSales,
    totalPayments,
    totalCredits,
    closingBalance: round2(round2(openingBalance) + totalSales - totalPayments - totalCredits),
    orderIds: orders.map(o => o.id),
    invoiceIds: [...new Set(payments.map(p => p.invoiceId).filter((id): id is string => id != null))],
    creditNoteIds: credits.map(c => c.id),
  }
}

export interface ReconcileInput {
  stored: { openingBalance: number; totalSales: number; totalPayments: number; totalCredits?: number; closingBalance: number }
  orders: StatementOrderRow[]
  payments: StatementPaymentRow[]
  credits?: Array<{ id: string; amount: number }>
}

export interface ReconcileResult {
  ok: boolean
  salesFromOrders: number
  salesDiff: number
  paymentsFromRecords: number
  paymentsDiff: number
  creditsFromRecords: number
  creditsDiff: number
  /** 期初 + 销售 − 收款，用**存下来的**三个数验恒等式 */
  closingExpected: number
  closingDiff: number
  problems: string[]
}

/** 允许的分币误差：金额都是两位小数，超过半分就是真差异 */
const EPS = 0.005

/**
 * 逐笔核对。三件事分开算，不合并成一个 boolean ——
 * 「销售对不上」和「恒等式不成立」是两种完全不同的故障，混成一个 ✗ 就没法排查。
 */
export function reconcileStatement({ stored, orders, payments, credits = [] }: ReconcileInput): ReconcileResult {
  const salesFromOrders = round2(orders.reduce((s, o) => s + Number(o.incTaxTotal || 0), 0))
  const paymentsFromRecords = round2(payments.reduce((s, p) => s + Number(p.amount || 0), 0))
  const salesDiff = round2(salesFromOrders - Number(stored.totalSales || 0))
  const paymentsDiff = round2(paymentsFromRecords - Number(stored.totalPayments || 0))
  const creditsFromRecords = round2(credits.reduce((s, c) => s + Number(c.amount || 0), 0))
  const creditsDiff = round2(creditsFromRecords - Number(stored.totalCredits || 0))
  const closingExpected = round2(
    Number(stored.openingBalance || 0) + Number(stored.totalSales || 0) - Number(stored.totalPayments || 0) - Number(stored.totalCredits || 0),
  )
  const closingDiff = round2(closingExpected - Number(stored.closingBalance || 0))

  const problems: string[] = []
  if (Math.abs(salesDiff) > EPS) {
    problems.push(`本期销售额与订单明细差 €${salesDiff.toFixed(2)}（明细 €${salesFromOrders.toFixed(2)} vs 单据 €${Number(stored.totalSales).toFixed(2)}）—— 对账单是快照，生成后订单被改过会出现这个差额`)
  }
  if (Math.abs(paymentsDiff) > EPS) {
    problems.push(`本期收款与收款流水差 €${paymentsDiff.toFixed(2)}（流水 €${paymentsFromRecords.toFixed(2)} vs 单据 €${Number(stored.totalPayments).toFixed(2)}）`)
  }
  if (Math.abs(creditsDiff) > EPS) {
    problems.push(`本期贷项与贷记单明细差 €${creditsDiff.toFixed(2)}（明细 €${creditsFromRecords.toFixed(2)} vs 单据 €${Number(stored.totalCredits || 0).toFixed(2)}）`)
  }
  if (Math.abs(closingDiff) > EPS) {
    problems.push(`期末余额不满足「期初 + 销售 − 收款 − 贷项」，差 €${closingDiff.toFixed(2)}`)
  }
  return { ok: problems.length === 0, salesFromOrders, salesDiff, paymentsFromRecords, paymentsDiff, creditsFromRecords, creditsDiff, closingExpected, closingDiff, problems }
}
