/**
 * 数据分析中心 · 指标口径 SSOT
 * ============================================================================
 * 所有 /api/analytics/* 路由与分析页面必须从这里取口径常量，
 * 禁止在页面或 API 内自定义状态集合 / 时间口径 / 税口径。
 * 口径完整定义见 docs/20260703-analytics-metric-definitions.md。
 *
 * 三个时点口径（分开展示，不混用）：
 *   销售口径 = Order.confirmationDate   （销售额、毛利、客户分析）
 *   物流口径 = Order.deliveryDate       （配送、缺货、司机分析）
 *   财务口径 = Invoice.invoiceDate/postedAt（开票额、应收、账龄）
 *
 * 税口径（沿用 docs/20260701 SSOT）：
 *   OrderLine.subtotal = unitPrice × orderedQty，恒为税前；taxRate 为百分数。
 *   税后 = subtotal × (1 + taxRate/100)。对外展示默认税后，毛利按税前算。
 */

/** 计入销售额/毛利的订单状态（已确认及之后，不含取消） */
export const SALES_COUNTED_STATUSES = [
  'CONFIRMED',
  'WAVE_ASSIGNED',
  'IN_DELIVERY',
  'COMPLETED',
  'LOCKED',
] as const

/** 应收口径：POSTED 且 amountDue > 0（InvoiceStatus 无 PARTIAL，部分收款只减 amountDue） */
export const AR_OPEN_INVOICE_STATUS = 'POSTED' as const

/** 账龄分桶（天数上限，Infinity = 90+）；UNKNOWN 桶给 dueDate 无法解析的发票 */
export const AR_AGING_BUCKETS = [
  { key: 'current', label: '未到期', maxOverdueDays: 0 },
  { key: 'd1_30', label: '1-30 天', maxOverdueDays: 30 },
  { key: 'd31_60', label: '31-60 天', maxOverdueDays: 60 },
  { key: 'd61_90', label: '61-90 天', maxOverdueDays: 90 },
  { key: 'd90_plus', label: '90+ 天', maxOverdueDays: Infinity },
] as const

export type ArAgingBucketKey = (typeof AR_AGING_BUCKETS)[number]['key'] | 'unknown'

/**
 * 账龄分桶口径 —— 应收（ar-aging）与应付（ap-aging）共用同一套阈值。
 * 两张表阈值必须一致，否则「应收 60 天以上 vs 应付 60 天以上」没法对读，
 * 资金缺口就成了两套口径拼出来的假象。
 */
export const AGING_BUCKETS = AR_AGING_BUCKETS
export type AgingBucketKey = ArAgingBucketKey

/** 流失预警参数：前 8~30 天有 ≥MIN_PRIOR_ORDERS 单、近 CHURN_QUIET_DAYS 天 0 单 */
export const CHURN_QUIET_DAYS = 7
export const CHURN_LOOKBACK_DAYS = 30
export const CHURN_MIN_PRIOR_ORDERS = 2

/** 库存周转/损耗统计的默认回看窗口（天） */
export const TURNOVER_WINDOW_DAYS = 30

/** 分析 API 默认日期范围（天）与最大允许范围（防全表扫描） */
export const ANALYTICS_DEFAULT_RANGE_DAYS = 30
export const ANALYTICS_MAX_RANGE_DAYS = 400

/**
 * Invoice.dueDate / postedAt 是 String 列（历史遗留），安全 parse。
 * 返回 null 表示无法解析 → 归入 'unknown' 账龄桶并单独计数展示。
 */
export function parseInvoiceDate(raw: string | null | undefined): Date | null {
  if (!raw || typeof raw !== 'string') return null
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : d
}

/** 逾期天数 → 账龄桶 key（dueDate 为 null 时调用方直接用 'unknown'） */
export function agingBucketKey(overdueDays: number): ArAgingBucketKey {
  for (const b of AR_AGING_BUCKETS) {
    if (overdueDays <= b.maxOverdueDays) return b.key
  }
  return 'd90_plus'
}

/** 解析日期范围查询参数，越界回退默认；返回 [start, end)（end 为独占上界） */
export function resolveDateRange(
  fromParam: string | null,
  toParam: string | null,
): { start: Date; end: Date } {
  const today = new Date()
  today.setHours(0, 0, 0, 0)
  const defaultStart = new Date(today)
  defaultStart.setDate(defaultStart.getDate() - ANALYTICS_DEFAULT_RANGE_DAYS + 1)
  const defaultEnd = new Date(today)
  defaultEnd.setDate(defaultEnd.getDate() + 1)

  let start = fromParam ? new Date(fromParam) : defaultStart
  let end = toParam ? new Date(toParam) : defaultEnd
  if (Number.isNaN(start.getTime())) start = defaultStart
  if (Number.isNaN(end.getTime())) end = defaultEnd
  start.setHours(0, 0, 0, 0)
  end.setHours(0, 0, 0, 0)
  // to 参数语义是"含当日"，转独占上界
  if (toParam && !Number.isNaN(new Date(toParam).getTime())) {
    end.setDate(end.getDate() + 1)
  }
  if (end <= start) {
    end = new Date(start)
    end.setDate(end.getDate() + 1)
  }
  const spanDays = (end.getTime() - start.getTime()) / 86400000
  if (spanDays > ANALYTICS_MAX_RANGE_DAYS) {
    start = new Date(end)
    start.setDate(start.getDate() - ANALYTICS_MAX_RANGE_DAYS)
  }
  return { start, end }
}

/** YYYY-MM-DD（本地时区），快照/分组统一用它做日 key */
export function toDayKey(d: Date): string {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}-${m}-${day}`
}

/** 客单价 = 销售额（税前） / 订单数，订单数为 0 时记 0，避免除零。四舍五入到分。 */
export function deriveAov(salesExTax: number, orderCount: number): number {
  return orderCount > 0 ? Math.round((salesExTax / orderCount) * 100) / 100 : 0
}
