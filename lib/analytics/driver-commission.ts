/**
 * 司机提成考核报表 —— 查询层（台账 H3）
 * ============================================================================
 * 回答三个问题：这个周期每个司机挣了多少 / 由哪些单构成 / 每单的钱是怎么算出来的。
 *
 * ## 归属主体是 Trip，不是 Order.driverSlotId
 *
 * 提成是发给**实际跑这趟的司机**的，而冻结动作本身也是按 Trip 触发的
 * （`trips PUT status=COMPLETED` → 逐单 `recalcOrderCommission` → `recalcTripDriverCommission`）。
 * 所以这里从 Trip 展开 `restaurants[].orderIds` 再 join 订单，而不是走 `Order.driverSlotId`
 * —— 后者是"计划派给谁"，改派后与实际执行人可能分叉（20260708 那个坑）。
 *
 * ## 为什么构成是 SQL 重算，而合计取冻结值
 *
 * 库里只存了**合计**（`Order.driverCommissionTotal`），三项构成（件提成 / 固定费 / 比例提成）
 * 没有落库。要在报表里解释"这笔钱怎么来的"就只能重算。
 *
 * 但重算不能替代冻结值：冻结之后 `deliveredQty` 还可能被退货审核改动，
 * 那时重算值与冻结值就该不一样 —— 这个差额正是考核要看见的东西，不是误差。
 * 所以两个数都给出来，并把差额单列一列。
 *
 * ## 与 lib/commission.ts 的关系
 *
 * `lib/commission.ts` 是提成的**唯一计算入口**，但它逐单逐行走 `toStockQty`
 * （每行 4 次查询），报表拿它算几百单会直接超时。这里用等价的 SQL 表达同一个公式：
 *
 *     提成 = Σ(件提成价 × 实送量 × 单位换算比) + 客户固定费 + Σ(单价 × 实送量) × 提成率
 *
 * 单位换算比与 `toStockQty` 逐条对齐（见下方 `UOM_RATIO_SQL` 注释）。
 * ⛔ **两套实现必须靠外部比对来守**：`scripts/audit/driver-commission-test.ts` 用
 * `calcOrderCommission` 逐单重算再与本模块的输出比对。拿同一段实现两边一比毫无信息量。
 */
import type { PrismaClient } from '@/lib/generated/prisma/client'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Db = PrismaClient | any

export type PeriodGrain = 'day' | 'week' | 'month'

export interface DriverCommissionQuery {
  start: Date
  end: Date
  /**
   * 只看某个司机。**必须与汇总的分组键一致**，即 (driverId, driverName) 这一对。
   *
   * ⛔ 只按 driverId 筛是错的：实测测试库里 BAO / AFZAAL / SEAN 三个人共用同一个
   * `Trip.driverId`（种子写 Trip 时填的是同一个 id），只按 id 筛会把三个人一起带出来
   * —— 页面上表现为「点了某个司机，数字纹丝不动」。
   * Trip.driverId 与 driverName 不保证一对一是**数据层的既有问题**（台账 C6 要解决的正是它），
   * 报表这一层不能假设它成立。
   */
  driverId?: string | null
  driverName?: string | null
  grain?: PeriodGrain
  /** 明细返回条数上限，防止一次拉全年 */
  detailLimit?: number
}

export interface DriverSummaryRow {
  driverId: string | null
  driverName: string
  tripCount: number
  orderCount: number
  /** 已冻结的单数 —— 只有这部分是"可以据以发钱"的 */
  frozenOrderCount: number
  deliveredSubtotal: number
  itemTotal: number
  fixedFee: number
  rateTotal: number
  /** 按公式重算的合计 */
  computedTotal: number
  /** 库中冻结值之和（未冻结的单计 0） */
  frozenTotal: number
  /** 重算 − 冻结。非零说明冻结后实送量还被改过，或压根没冻结 */
  diff: number
}

export interface DriverPeriodRow {
  period: string
  driverId: string | null
  driverName: string
  orderCount: number
  computedTotal: number
  frozenTotal: number
}

export interface DriverCommissionDetailRow {
  orderId: string
  orderCode: string | null
  bizDate: string
  driverId: string | null
  driverName: string
  tripId: string
  tripName: string | null
  restaurantName: string
  orderStatus: string
  deliveredSubtotal: number
  itemTotal: number
  fixedFee: number
  rateTotal: number
  computedTotal: number
  frozenTotal: number | null
  frozenAt: string | null
  diff: number
}

export interface DriverCommissionPayload {
  byDriver: DriverSummaryRow[]
  byPeriod: DriverPeriodRow[]
  detail: DriverCommissionDetailRow[]
  totals: {
    driverCount: number
    orderCount: number
    frozenOrderCount: number
    computedTotal: number
    frozenTotal: number
    diff: number
  }
  /** 明细是否被 limit 截断 —— 截断了却不说，读的人会以为看到的就是全部 */
  detailTruncated: boolean
}

/**
 * 明细导出成 CSV。放在 lib 里而不是页面里，是为了能单测 —— 导出的数字与
 * 屏幕上的数字必须来自同一个结果对象（D9 的做法），转义也得真的转。
 * 前置 BOM：Excel 不给 BOM 会把中文列头读成乱码。
 */
export function detailToCsv(rows: DriverCommissionDetailRow[]): string {
  const head = ['日期', '司机', '订单号', '客户', '状态', '实送金额', '件提成', '固定费', '比例提成', '重算合计', '冻结合计', '差异']
  const esc = (v: string | number | null) => {
    const s = String(v ?? '')
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const lines = rows.map(r => [
    r.bizDate, r.driverName, r.orderCode ?? r.orderId, r.restaurantName, r.orderStatus,
    r.deliveredSubtotal, r.itemTotal, r.fixedFee, r.rateTotal, r.computedTotal,
    r.frozenAt ? (r.frozenTotal ?? 0) : '未冻结', r.diff,
  ].map(esc).join(','))
  return '﻿' + [head.join(','), ...lines].join('\n')
}

/**
 * 把「周期 × 司机」的长表转成交叉表。行=周期、列=司机，缺格留空而不是补 0 ——
 * 「这天这个司机没跑车」和「跑了但提成为 0」是两件事，补 0 会把前者说成后者。
 */
export function pivotPeriods(rows: DriverPeriodRow[]): {
  drivers: string[]
  periods: string[]
  cell: (period: string, driver: string) => DriverPeriodRow | undefined
  rowTotal: (period: string) => number
} {
  const drivers = [...new Set(rows.map(r => r.driverName))].sort()
  const periods = [...new Set(rows.map(r => r.period))].sort()
  const map = new Map(rows.map(r => [`${r.period}|${r.driverName}`, r]))
  return {
    drivers, periods,
    cell: (p, d) => map.get(`${p}|${d}`),
    rowTotal: (p) => round2(rows.filter(r => r.period === p).reduce((s, r) => s + r.computedTotal, 0)),
  }
}

/**
 * 单位换算比，与 `lib/inventory.ts` 的 `toStockQty` 逐条对齐：
 *   · 行没有 uomId → 不换算
 *   · 模板没有基准单位 → 不换算
 *   · 行单位 == 基准单位 → 不换算
 *   · 任一 factor 缺失或为 0 → 不换算（toStockQty 里的 `!lineFactor || !anchorFactor`）
 * 否则 ratio = 行单位 factor / 基准单位 factor。
 */
const UOM_RATIO_SQL = `
  CASE
    WHEN ol."uomId" IS NULL
      OR pt."uomId" IS NULL
      OR ol."uomId" = pt."uomId"
      OR lu.factor IS NULL OR au.factor IS NULL
      OR lu.factor = 0 OR au.factor = 0
    THEN 1
    ELSE lu.factor / au.factor
  END`

/**
 * 公共 CTE：把「区间内的 Trip」展开成「Trip × 订单」，再把每单的行级构成算好。
 *
 * 日期口径与 `/api/analytics/logistics` 保持一致：取所属波次的 waveDate，
 * 手工建的无波次 Trip 退回 `Trip.createdAt::date`。两页口径不同的话，
 * 同一个司机在物流分析里跑了 8 趟、在提成报表里只有 6 趟，没人说得清哪个对。
 *
 * `restaurants` 里 orderIds 可能整个缺失（历史/异常数据），用 COALESCE 兜住，
 * 否则 jsonb_array_elements_text(NULL) 会把整个 Trip 悄悄丢掉。
 */
function baseCte(filters: { byId: boolean; byName: boolean }): string {
  const conds = [
    filters.byId ? 'AND t."driverId" = $3' : '',
    filters.byName ? `AND COALESCE(NULLIF(t."driverName", ''), '未指定') = $${filters.byId ? 4 : 3}` : '',
  ].filter(Boolean).join('\n    ')
  return `
WITH trip_order AS (
  SELECT t.id                                        AS trip_id,
         t.name                                      AS trip_name,
         t."driverId"                                AS driver_id,
         COALESCE(NULLIF(t."driverName", ''), '未指定') AS driver_name,
         COALESCE(w."waveDate", t."createdAt"::date)  AS biz_date,
         oid                                          AS order_id
  FROM "Trip" t
  LEFT JOIN "PickingWave" w ON w.id = t."waveId"
  CROSS JOIN LATERAL jsonb_array_elements(
    CASE WHEN jsonb_typeof(t.restaurants) = 'array' THEN t.restaurants ELSE '[]'::jsonb END
  ) r
  CROSS JOIN LATERAL jsonb_array_elements_text(
    CASE WHEN jsonb_typeof(r->'orderIds') = 'array' THEN r->'orderIds' ELSE '[]'::jsonb END
  ) oid
  WHERE t.status <> 'PENDING'
    AND COALESCE(w."waveDate", t."createdAt"::date) >= $1
    AND COALESCE(w."waveDate", t."createdAt"::date) <  $2
    ${conds}
),
line_agg AS (
  SELECT ol."orderId" AS order_id,
         SUM(COALESCE(ol."commissionPrice", 0) * COALESCE(ol."deliveredQty", 0) * (${UOM_RATIO_SQL})) AS item_total,
         SUM(COALESCE(ol."unitPrice", 0) * COALESCE(ol."deliveredQty", 0))                            AS delivered_subtotal,
         SUM(COALESCE(ol."deliveredQty", 0))                                                          AS delivered_qty
  FROM "OrderLine" ol
  JOIN trip_order to2            ON to2.order_id = ol."orderId"
  LEFT JOIN "Product" p          ON p.id  = ol."productId"
  LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
  LEFT JOIN "Uom" lu             ON lu.id = ol."uomId"
  LEFT JOIN "Uom" au             ON au.id = pt."uomId"
  GROUP BY ol."orderId"
),
order_calc AS (
  SELECT tord.trip_id, tord.trip_name, tord.driver_id, tord.driver_name, tord.biz_date,
         o.id AS order_id, o.code AS order_code, o.status::text AS order_status,
         o."restaurantName" AS restaurant_name,
         o."driverCommissionTotal" AS frozen_total,
         o."commissionFrozenAt"    AS frozen_at,
         COALESCE(la.item_total, 0)         AS item_total,
         COALESCE(la.delivered_subtotal, 0) AS delivered_subtotal,
         -- 「整单一件都没送到就不给固定费」——与 sumCommission 的 anyDelivered 同义
         CASE WHEN COALESCE(la.delivered_qty, 0) > 0
              THEN COALESCE(o."commissionFixed", 0) ELSE 0 END AS fixed_fee,
         COALESCE(la.delivered_subtotal, 0) * COALESCE(o."commissionRate", 0) AS rate_total
  FROM trip_order tord
  JOIN "Order" o ON o.id = tord.order_id
  LEFT JOIN line_agg la ON la.order_id = o.id
)`
}

const TOTAL_EXPR = '(oc.item_total + oc.fixed_fee + oc.rate_total)'

function num(v: unknown): number {
  const n = Number(v ?? 0)
  return Number.isFinite(n) ? n : 0
}
const round2 = (n: number) => Math.round(n * 100) / 100

/** week 用 ISO 周一为界，与销售矩阵的按周口径一致（D9） */
function grainTrunc(grain: PeriodGrain): string {
  return grain === 'week' ? 'week' : grain === 'month' ? 'month' : 'day'
}

export async function fetchDriverCommission(
  db: Db,
  q: DriverCommissionQuery,
): Promise<DriverCommissionPayload> {
  const { start, end, driverId, driverName, grain = 'day' } = q
  const detailLimit = q.detailLimit ?? 500
  const byId = !!driverId
  const byName = !!driverName
  const params: unknown[] = [start, end, ...(byId ? [driverId] : []), ...(byName ? [driverName] : [])]
  const cte = baseCte({ byId, byName })

  const byDriverRaw = (await db.$queryRawUnsafe(
    `${cte}
     SELECT oc.driver_id, oc.driver_name,
            COUNT(DISTINCT oc.trip_id)::int  AS trip_count,
            COUNT(DISTINCT oc.order_id)::int AS order_count,
            COUNT(DISTINCT oc.order_id) FILTER (WHERE oc.frozen_at IS NOT NULL)::int AS frozen_order_count,
            SUM(oc.delivered_subtotal)::float AS delivered_subtotal,
            SUM(oc.item_total)::float         AS item_total,
            SUM(oc.fixed_fee)::float          AS fixed_fee,
            SUM(oc.rate_total)::float         AS rate_total,
            SUM(${TOTAL_EXPR})::float                     AS computed_total,
            SUM(COALESCE(oc.frozen_total, 0))::float      AS frozen_total
     FROM order_calc oc
     GROUP BY oc.driver_id, oc.driver_name
     ORDER BY SUM(${TOTAL_EXPR}) DESC NULLS LAST`,
    ...params,
  )) as Array<Record<string, unknown>>

  const byPeriodRaw = (await db.$queryRawUnsafe(
    `${cte}
     SELECT to_char(date_trunc('${grainTrunc(grain)}', oc.biz_date::timestamp), 'YYYY-MM-DD') AS period,
            oc.driver_id, oc.driver_name,
            COUNT(DISTINCT oc.order_id)::int          AS order_count,
            SUM(${TOTAL_EXPR})::float                 AS computed_total,
            SUM(COALESCE(oc.frozen_total, 0))::float  AS frozen_total
     FROM order_calc oc
     GROUP BY 1, oc.driver_id, oc.driver_name
     ORDER BY 1, oc.driver_name`,
    ...params,
  )) as Array<Record<string, unknown>>

  const detailRaw = (await db.$queryRawUnsafe(
    `${cte}
     SELECT oc.order_id, oc.order_code,
            -- 必须在 SQL 里格成字符串。直接把 date 交出去，序列化后到前端是
            -- Date 对象，String(d).slice(0,10) 得到的是 "Wed Aug 05" 这种本地化
            -- 星期串 —— 浏览器实测才看出来，接口断言完全发现不了。
            to_char(oc.biz_date, 'YYYY-MM-DD') AS biz_date,
            oc.driver_id, oc.driver_name,
            oc.trip_id, oc.trip_name, oc.restaurant_name, oc.order_status,
            oc.delivered_subtotal::float, oc.item_total::float,
            oc.fixed_fee::float, oc.rate_total::float,
            ${TOTAL_EXPR}::float AS computed_total,
            oc.frozen_total::float, oc.frozen_at
     FROM order_calc oc
     ORDER BY oc.biz_date DESC, oc.driver_name, oc.order_code NULLS LAST
     LIMIT ${detailLimit + 1}`,
    ...params,
  )) as Array<Record<string, unknown>>

  const detailTruncated = detailRaw.length > detailLimit
  const detail: DriverCommissionDetailRow[] = detailRaw.slice(0, detailLimit).map((r) => {
    const computed = round2(num(r.computed_total))
    const frozen = r.frozen_total == null ? null : round2(num(r.frozen_total))
    return {
      orderId: String(r.order_id),
      orderCode: r.order_code == null ? null : String(r.order_code),
      bizDate: String(r.biz_date),
      driverId: r.driver_id == null ? null : String(r.driver_id),
      driverName: String(r.driver_name),
      tripId: String(r.trip_id),
      tripName: r.trip_name == null ? null : String(r.trip_name),
      restaurantName: String(r.restaurant_name ?? ''),
      orderStatus: String(r.order_status),
      deliveredSubtotal: round2(num(r.delivered_subtotal)),
      itemTotal: round2(num(r.item_total)),
      fixedFee: round2(num(r.fixed_fee)),
      rateTotal: round2(num(r.rate_total)),
      computedTotal: computed,
      frozenTotal: frozen,
      frozenAt: r.frozen_at == null ? null : new Date(String(r.frozen_at)).toISOString(),
      diff: round2(computed - (frozen ?? 0)),
    }
  })

  const byDriver: DriverSummaryRow[] = byDriverRaw.map((r) => {
    const computed = round2(num(r.computed_total))
    const frozen = round2(num(r.frozen_total))
    return {
      driverId: r.driver_id == null ? null : String(r.driver_id),
      driverName: String(r.driver_name),
      tripCount: num(r.trip_count),
      orderCount: num(r.order_count),
      frozenOrderCount: num(r.frozen_order_count),
      deliveredSubtotal: round2(num(r.delivered_subtotal)),
      itemTotal: round2(num(r.item_total)),
      fixedFee: round2(num(r.fixed_fee)),
      rateTotal: round2(num(r.rate_total)),
      computedTotal: computed,
      frozenTotal: frozen,
      diff: round2(computed - frozen),
    }
  })

  const byPeriod: DriverPeriodRow[] = byPeriodRaw.map((r) => ({
    period: String(r.period),
    driverId: r.driver_id == null ? null : String(r.driver_id),
    driverName: String(r.driver_name),
    orderCount: num(r.order_count),
    computedTotal: round2(num(r.computed_total)),
    frozenTotal: round2(num(r.frozen_total)),
  }))

  const totals = byDriver.reduce(
    (acc, d) => ({
      driverCount: acc.driverCount + 1,
      orderCount: acc.orderCount + d.orderCount,
      frozenOrderCount: acc.frozenOrderCount + d.frozenOrderCount,
      computedTotal: acc.computedTotal + d.computedTotal,
      frozenTotal: acc.frozenTotal + d.frozenTotal,
      diff: 0,
    }),
    { driverCount: 0, orderCount: 0, frozenOrderCount: 0, computedTotal: 0, frozenTotal: 0, diff: 0 },
  )
  totals.computedTotal = round2(totals.computedTotal)
  totals.frozenTotal = round2(totals.frozenTotal)
  totals.diff = round2(totals.computedTotal - totals.frozenTotal)

  return { byDriver, byPeriod, detail, totals, detailTruncated }
}
