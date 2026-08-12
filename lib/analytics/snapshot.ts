/**
 * 每日经营快照生成器
 * ============================================================================
 * 口径见 lib/analytics/metrics.ts 与 docs/20260703-analytics-metric-definitions.md。
 * - ensureSnapshots()：惰性补齐缺失日期（幂等），当天不写快照（当天永远实时算）
 * - recomputeSnapshots(from, to)：订正数据后强制重算
 * - computeDayMetrics(day)：单日指标计算（当天实时展示也走这里，保证口径唯一）
 */
import { prisma } from '@/lib/db'
import {
  SALES_COUNTED_STATUSES,
  addBusinessDays,
  businessDayRange,
  businessDayStart,
  businessTodayStart,
  toDayKey,
} from '@/lib/analytics/metrics'

/** 常量状态集合 → SQL IN 字面量（非用户输入，安全内联） */
const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export interface DayMetrics {
  salesExTax: number
  salesIncTax: number
  grossProfit: number
  costCoverageRate: number
  orderCount: number
  activeCustomers: number
  shortageLines: number
  orderLines: number
  creditNoteAmount: number
  scrapAmount: number
  purchaseExTax: number
  arBalance: number
  arOverdue: number
}

/**
 * 计算某一天的全部快照指标。day = 该业务日内的任意时刻。
 * ⛔ 边界按**业务时区**（都柏林）切，不是进程本地时区 —— 原来是
 * `start.setHours(0,0,0,0)`，在 UTC 容器上等于按 UTC 日切，而这一行下面
 * 的成本/应收参数和 upsert 的 key 都用 toDayKey（都柏林），两者错位一小时，
 * 夏令时期间都柏林 00:00–01:00 的单子会被算进前一天（见 metrics.businessDayRange）。
 */
export async function computeDayMetrics(day: Date): Promise<DayMetrics> {
  const { start, end } = businessDayRange(day)

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any

  // 销售口径：销售额/毛利/订单数/活跃客户（confirmationDate 归日）
  // 成本优先级：≤当日最近的批次加权成本 → Product.standardPrice → Template.standardPrice
  const salesRows = (await p.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM(ol.subtotal), 0)::float AS sales_ex,
       COALESCE(SUM(ol.subtotal * (1 + COALESCE(ol."taxRate", 0) / 100)), 0)::float AS sales_inc,
       COUNT(DISTINCT o.id)::int AS order_count,
       COUNT(DISTINCT o."restaurantId")::int AS active_customers,
       COALESCE(SUM((ol."unitPrice" - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0)) * ol."orderedQty"), 0)::float AS gross_profit,
       COALESCE(SUM(CASE WHEN lc.unit_cost IS NOT NULL THEN ol.subtotal ELSE 0 END), 0)::float AS costed_amount
     FROM "OrderLine" ol
     JOIN "Order" o ON o.id = ol."orderId"
     LEFT JOIN "Product" p ON p.id = ol."productId"
     LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
     LEFT JOIN LATERAL (
       SELECT c.unit_cost FROM v_lot_daily_cost c
       WHERE c.product_id = ol."productId" AND c.cost_date <= $1::date
       ORDER BY c.cost_date DESC LIMIT 1
     ) lc ON TRUE
     WHERE o.status::text IN (${SALES_STATUS_SQL})
       AND o."confirmationDate" >= $2 AND o."confirmationDate" < $3`,
    toDayKey(start), start, end,
  )) as Array<{
    sales_ex: number; sales_inc: number; order_count: number
    active_customers: number; gross_profit: number; costed_amount: number
  }>
  const s = salesRows[0]

  // 物流口径：缺货行/订单行（deliveryDate 归日）
  const logisticsRows = (await p.$queryRawUnsafe(
    `SELECT
       (SELECT COUNT(*)::int FROM "OrderDiscrepancy" d
          JOIN "Order" o ON o.id = d."orderId"
         WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
           AND d.status <> 'CANCELLED') AS shortage_lines,
       (SELECT COUNT(*)::int FROM "OrderLine" ol
          JOIN "Order" o ON o.id = ol."orderId"
         WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
           AND o.status::text IN (${SALES_STATUS_SQL})) AS order_lines`,
    start, end,
  )) as Array<{ shortage_lines: number; order_lines: number }>
  const lg = logisticsRows[0]

  // 退货额（税前）：CONFIRMED / APPLIED，按 creditDate
  const cnRows = (await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM("subtotalExTax"), 0)::float AS amount
     FROM "CreditNote"
     WHERE status IN ('CONFIRMED', 'APPLIED')
       AND "creditDate" >= $1 AND "creditDate" < $2`,
    start, end,
  )) as Array<{ amount: number }>

  // 损耗额：SCRAP 全部 + 盘亏（STOCK_TAKE 的负向 ADJUSTMENT），按批次成本 fallback standardPrice
  const scrapRows = (await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM(ABS(sm.qty) * COALESCE(l."unitCost", p."standardPrice", pt."standardPrice", 0)), 0)::float AS amount
     FROM "StockMove" sm
     LEFT JOIN "Lot" l ON l.id = sm."lotId"
     LEFT JOIN "Product" p ON p.id = sm."productId"
     LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
     WHERE sm."movedAt" >= $1 AND sm."movedAt" < $2
       AND (sm.type = 'SCRAP' OR (sm.type = 'ADJUSTMENT' AND sm."sourceType" = 'STOCK_TAKE' AND sm.qty < 0))`,
    start, end,
  )) as Array<{ amount: number }>

  // 采购额（税前）：按 PO 确认日（orderDate 无确认时间戳，用 createdAt 归日的 CONFIRMED+ 单）
  const poRows = (await p.$queryRawUnsafe(
    `SELECT COALESCE(SUM(pol."subtotalExTax"), 0)::float AS amount
     FROM "PurchaseOrderLine" pol
     JOIN "PurchaseOrder" po ON po.id = pol."purchaseOrderId"
     WHERE po.status::text IN ('CONFIRMED', 'RECEIVED', 'INVOICED', 'LOCKED')
       AND po."createdAt" >= $1 AND po."createdAt" < $2`,
    start, end,
  )) as Array<{ amount: number }>

  // 应收快照：当前 POSTED 且 amountDue > 0（历史日无法回溯当日余额，快照存生成时点的值）
  // 逾期 = dueDate 可解析且 < 快照日
  const arRows = (await p.$queryRawUnsafe(
    `SELECT
       COALESCE(SUM("amountDue"), 0)::float AS balance,
       COALESCE(SUM(CASE
         WHEN "dueDate" ~ '^\\d{4}-\\d{2}-\\d{2}' AND "dueDate"::date < $1::date
         THEN "amountDue" ELSE 0 END), 0)::float AS overdue
     FROM "Invoice"
     WHERE status = 'POSTED' AND "amountDue" > 0`,
    toDayKey(start),
  )) as Array<{ balance: number; overdue: number }>

  const round2 = (n: number) => Math.round(n * 100) / 100
  return {
    salesExTax: round2(s.sales_ex),
    salesIncTax: round2(s.sales_inc),
    grossProfit: round2(s.gross_profit),
    costCoverageRate: s.sales_ex > 0 ? Math.round((s.costed_amount / s.sales_ex) * 10000) / 10000 : 0,
    orderCount: s.order_count,
    activeCustomers: s.active_customers,
    shortageLines: lg.shortage_lines,
    orderLines: lg.order_lines,
    creditNoteAmount: round2(cnRows[0].amount),
    scrapAmount: round2(scrapRows[0].amount),
    purchaseExTax: round2(poRows[0].amount),
    arBalance: round2(arRows[0].balance),
    arOverdue: round2(arRows[0].overdue),
  }
}

async function upsertSnapshot(day: Date, metrics: DayMetrics) {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const dayKey = toDayKey(day)
  await p.dailyBusinessSnapshot.upsert({
    where: { snapshotDate: new Date(dayKey) },
    create: { snapshotDate: new Date(dayKey), ...metrics, computedAt: new Date() },
    update: { ...metrics, computedAt: new Date() },
  })
}

/** 快照最多回补的天数（首次启用时从最早订单起，封顶此值） */
const MAX_BACKFILL_DAYS = 120

/**
 * 单次请求最多同步补几天。Cloud Run min-instances=0，没有常驻进程跑 cron，所以
 * ensureSnapshots() 只能在请求里惰性补——但首次上线或服务长时间停机后，缺口可能
 * 一次积到 120 天，若不封顶会在一次 GET 请求里同步跑完 120 天 × 5 段 SQL，有超时
 * 风险。这里限制单次最多补这么多天，跑不完的下次调用（幂等，从缺口最早的一天继续）
 * 接着补，几次请求后自然追平，不需要额外的后台任务/队列基础设施。
 */
const MAX_FILL_PER_CALL = 20

/**
 * 惰性补齐缺失快照：从（最早确认日 或 昨天−MAX_BACKFILL_DAYS 取晚者）到昨天。
 * 已存在的日期跳过（幂等）。单次最多补 MAX_FILL_PER_CALL 天，避免单次请求阻塞。
 * 返回补了多少天。
 */
export async function ensureSnapshots(): Promise<number> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  const today = businessTodayStart()
  const yesterday = addBusinessDays(today, -1)

  const earliest = (await p.$queryRawUnsafe(
    `SELECT MIN("confirmationDate")::date AS d FROM "Order" WHERE "confirmationDate" IS NOT NULL`,
  )) as Array<{ d: Date | null }>
  if (!earliest[0]?.d) return 0

  const floor = addBusinessDays(yesterday, -(MAX_BACKFILL_DAYS - 1))
  let cursor = businessDayStart(new Date(earliest[0].d))
  if (cursor < floor) cursor = floor

  const existing = (await p.dailyBusinessSnapshot.findMany({
    select: { snapshotDate: true },
  })) as Array<{ snapshotDate: Date }>
  // @db.Date 读回是 UTC 午夜，用 ISO 串取日 key（避免本地时区偏移导致幂等失败）
  const have = new Set(existing.map((e) => new Date(e.snapshotDate).toISOString().slice(0, 10)))

  let filled = 0
  while (cursor <= yesterday && filled < MAX_FILL_PER_CALL) {
    if (!have.has(toDayKey(cursor))) {
      const metrics = await computeDayMetrics(cursor)
      await upsertSnapshot(cursor, metrics)
      filled++
    }
    cursor = addBusinessDays(cursor, 1)
  }
  return filled
}

/** 强制重算 [from, to]（含两端，不含今天及以后），订正数据后调用。返回重算天数。 */
export async function recomputeSnapshots(from: Date, to: Date): Promise<number> {
  const today = businessTodayStart()
  let cursor = businessDayStart(from)
  const endDay = businessDayStart(to)
  let count = 0
  while (cursor <= endDay && cursor < today && count < MAX_BACKFILL_DAYS) {
    const metrics = await computeDayMetrics(cursor)
    await upsertSnapshot(cursor, metrics)
    count++
    cursor = addBusinessDays(cursor, 1)
  }
  return count
}
