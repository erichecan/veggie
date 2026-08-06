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

/**
 * 业务时区。客户是爱尔兰实体，日报 / 波次 / 交账都按都柏林的业务日切分。
 *
 * ⛔ 不要改成 UTC 图省事：实测有 **1,909 张订单（占 1.27%）** 的
 * `confirmationDate` 在 UTC 与都柏林下分属不同日期，按 UTC 切会把它们算到相邻的
 * 错误日期上。夏令时（IST，UTC+1）期间尤其明显 —— 都柏林 00:00–01:00 的单子，
 * 在 UTC 眼里还是前一天。
 *
 * 数据库存 UTC、这里转业务时区展示与切分，是正确的分层；不要反过来去改容器时区
 * （容器内 TZ 保持 UTC 是刻意的，见 docs/20260805-server-baseline.md §2.2）。
 */
export const BUSINESS_TIMEZONE = 'Europe/Dublin'

/** 某个 UTC 时刻在业务时区的偏移（毫秒）。夏令时会变，所以必须按时刻算而非取常数。 */
function tzOffsetMs(at: Date, tz: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(at)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  // 把"该时区显示出来的墙上时间"当作 UTC 再取时间戳，与真实 UTC 时刻的差就是偏移
  const asIfUtc = Date.UTC(g('year'), g('month') - 1, g('day'), g('hour') % 24, g('minute'), g('second'))
  return asIfUtc - at.getTime()
}

/** 业务时区某一天的 00:00 对应的真实 UTC 时刻 */
function zonedDayStart(y: number, m: number, d: number, tz = BUSINESS_TIMEZONE): Date {
  const guess = Date.UTC(y, m - 1, d, 0, 0, 0, 0)
  // 先用"猜测时刻"的偏移反推，再用反推结果的偏移复核 —— 夏令时切换当天两者会不同
  const off1 = tzOffsetMs(new Date(guess), tz)
  let ts = guess - off1
  const off2 = tzOffsetMs(new Date(ts), tz)
  if (off2 !== off1) ts = guess - off2
  return new Date(ts)
}

/** 把 Date 拆成它在业务时区的 [年, 月, 日] */
function zonedYMD(at: Date, tz = BUSINESS_TIMEZONE): [number, number, number] {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(at)
  const g = (t: string) => Number(parts.find((p) => p.type === t)!.value)
  return [g('year'), g('month'), g('day')]
}

/** 只认 YYYY-MM-DD；带时刻的 ISO 串也接受，取其业务时区下的日期部分 */
function parseDayParam(raw: string | null): [number, number, number] | null {
  if (!raw) return null
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(raw.trim())
  if (m) return [Number(m[1]), Number(m[2]), Number(m[3])]
  const d = new Date(raw)
  return Number.isNaN(d.getTime()) ? null : zonedYMD(d)
}

/** 在业务时区下给某天加减天数，返回该天 00:00 的 UTC 时刻 */
function addDaysZoned(y: number, m: number, d: number, delta: number): Date {
  // 用 UTC 算术推日期，再交给 zonedDayStart 处理时区/夏令时
  const t = new Date(Date.UTC(y, m - 1, d))
  t.setUTCDate(t.getUTCDate() + delta)
  return zonedDayStart(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate())
}

/**
 * 解析日期范围查询参数，越界回退默认；返回 [start, end)（end 为独占上界）。
 *
 * ⛔ 边界一律按业务时区（见 BUSINESS_TIMEZONE），**与进程所在时区无关**。
 * 原实现是 `new Date('2026-01-01')` 再 `.setHours(0,0,0,0)`：前者按 UTC 解析
 * date-only 字符串，后者按进程本地时区生效，两者不一致时整个范围偏一天。
 * 生产容器是 UTC 所以碰巧不显现，本地开发（UTC-4）实测差 19 小时，
 * 会把 2025-12 的数据串进 2026-01 的查询里。tests/analytics-date-range-tz.test.ts 锁住了这点。
 */
export function resolveDateRange(
  fromParam: string | null,
  toParam: string | null,
): { start: Date; end: Date } {
  const [ty, tm, td] = zonedYMD(new Date())
  const defaultStart = addDaysZoned(ty, tm, td, -ANALYTICS_DEFAULT_RANGE_DAYS + 1)
  const defaultEnd = addDaysZoned(ty, tm, td, 1)

  const fromYMD = parseDayParam(fromParam)
  const toYMD = parseDayParam(toParam)

  let start = fromYMD ? zonedDayStart(...fromYMD) : defaultStart
  // to 参数语义是"含当日"，转独占上界
  let end = toYMD ? addDaysZoned(toYMD[0], toYMD[1], toYMD[2], 1) : defaultEnd

  if (end <= start) {
    const [sy, sm, sd] = zonedYMD(start)
    end = addDaysZoned(sy, sm, sd, 1)
  }
  if ((end.getTime() - start.getTime()) / 86400000 > ANALYTICS_MAX_RANGE_DAYS) {
    const [ey, em, ed] = zonedYMD(end)
    start = addDaysZoned(ey, em, ed, -ANALYTICS_MAX_RANGE_DAYS)
  }
  return { start, end }
}

/**
 * YYYY-MM-DD（**业务时区**），快照/分组统一用它做日 key。
 *
 * ⛔ 必须与 resolveDateRange 同口径：一个按都柏林切范围、另一个按 UTC 打 key 的话，
 * 边界那天的数据会落到范围外的 key 上，表现为"总数对得上但按天加起来少一截"。
 */
export function toDayKey(d: Date): string {
  const [y, m, day] = zonedYMD(d)
  return `${y}-${String(m).padStart(2, '0')}-${String(day).padStart(2, '0')}`
}

/** 客单价 = 销售额（税前） / 订单数，订单数为 0 时记 0，避免除零。四舍五入到分。 */
export function deriveAov(salesExTax: number, orderCount: number): number {
  return orderCount > 0 ? Math.round((salesExTax / orderCount) * 100) / 100 : 0
}
