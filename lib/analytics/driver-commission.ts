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
 * `lib/commission.ts` 是提成的**唯一计算入口**，报表拿它算几百单会因逐单查询直接超时。
 * 这里用等价的 SQL 表达同一个公式：
 *
 *     提成 = Σ(件提成价 × 实送量) + 客户固定费 + Σ(单价 × 实送量) × 提成率
 *
 * 20260901 起 `OrderLine.commissionPrice` 落库时就已经按该行选用单位折算好
 * （factor / FIXED override / FORMULA 折扣加价，见 lib/server-pricing.ts
 * resolveOrderLines），这里不再需要单独乘一遍单位换算比。
 * ⛔ **两套实现必须靠外部比对来守**：`scripts/audit/driver-commission-test.ts` 用
 * `calcOrderCommission` 逐单重算再与本模块的输出比对。拿同一段实现两边一比毫无信息量。
 */
import type { PrismaClient } from '@/lib/generated/prisma/client'
import { SALES_COUNTED_STATUSES, toNaiveTimestampParam } from '@/lib/analytics/metrics'

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
 * 公共 CTE：把「区间内的 Trip」展开成「Trip × 订单」，再把每单的行级构成算好。
 *
 * 日期口径与 `/api/analytics/logistics` 保持一致：取所属波次的 waveDate，
 * 手工建的无波次 Trip 退回 `Trip.createdAt::date`。两页口径不同的话，
 * 同一个司机在物流分析里跑了 8 趟、在提成报表里只有 6 趟，没人说得清哪个对。
 *
 * ⛔ waveDate 是 @db.Date，边界比较必须显式 ::timestamp，否则 Postgres 把 $1/$2
 * 隐式推成 date 丢时区偏移，区间末日整天消失（20260910 修复，见 docs/20260811 待决策 #15）。
 *
 * `restaurants` 里 orderIds 可能整个缺失（历史/异常数据），用 COALESCE 兜住，
 * 否则 jsonb_array_elements_text(NULL) 会把整个 Trip 悄悄丢掉。
 */
export function baseCte(filters: { byId: boolean; byName: boolean }): string {
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
         -- 20260922：波次的时段优先，手工建的无波次 Trip 回落到 Trip 自己的 timeSlot。
         -- ⛔ 两边大小写不统一：PickingWave.timeOfDay 是 "am"/"pm"（schema 注释），
         -- Trip.timeSlot 校验/写入的却是 "AM"/"PM"（app/api/trips/route.ts:62、
         -- lib/trip-from-wave.ts:39）。下游 timeOfDayLabel 只认小写，这里统一转小写，
         -- 不要指望调用方每处都做大小写兼容。
         LOWER(COALESCE(w."timeOfDay", t."timeSlot")) AS time_of_day,
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
    AND COALESCE(w."waveDate", t."createdAt"::date)::timestamp >= $1
    AND COALESCE(w."waveDate", t."createdAt"::date)::timestamp <  $2
    ${conds}
),
line_agg AS (
  SELECT ol."orderId" AS order_id,
         SUM(COALESCE(ol."commissionPrice", 0) * COALESCE(ol."deliveredQty", 0)) AS item_total,
         SUM(COALESCE(ol."unitPrice", 0) * COALESCE(ol."deliveredQty", 0))       AS delivered_subtotal,
         SUM(COALESCE(ol."deliveredQty", 0))                                    AS delivered_qty
  FROM "OrderLine" ol
  JOIN trip_order to2            ON to2.order_id = ol."orderId"
  -- 赠品行不计提成基数，与 lib/commission.ts:sumCommission 同一口径
  WHERE ol."isGift" = false
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

export interface DriverProductDetailRow {
  bizDate: string
  /** "am" | "pm" | null —— 无波次也无 Trip.timeSlot 的历史/手工数据取不到时段 */
  timeOfDay: string | null
  driverId: string | null
  driverName: string
  restaurantName: string
  productName: string
  uomName: string | null
  deliveredQty: number
  /** 送达金额 / 送达数量的加权均价 —— 同一产品同一天同一客户可能来自多单，单价未必完全一致 */
  avgUnitPrice: number
  deliveredSubtotal: number
}

/**
 * 每司机 × 每客户 × 每产品 × 每天(上午/下午) 送货明细（20260922，客户手写需求"司机一份，
 * 公司留一份"——用于司机与公司核对当天到底送了哪个客户多少件什么货，不是提成计算）。
 * ============================================================================
 * 归属/日期口径与 fetchDriverCommission 同一套 baseCte（Trip 展开），只是不再按订单聚合，
 * 而是下钻到 OrderLine 按（司机, 客户, 产品, 日期, 半天）分组——粒度比逐单明细更细。
 * 金额基准用 deliveredQty（实送量），与提成口径一致，不是下单量。
 */
export async function fetchDriverProductDetail(
  db: Db,
  q: DriverCommissionQuery,
): Promise<{ rows: DriverProductDetailRow[]; truncated: boolean }> {
  const { start, end, driverId, driverName } = q
  const detailLimit = q.detailLimit ?? 500
  const byId = !!driverId
  const byName = !!driverName
  const params: unknown[] = [start, end, ...(byId ? [driverId] : []), ...(byName ? [driverName] : [])]
  const cte = baseCte({ byId, byName })

  const rows = (await db.$queryRawUnsafe(
    `${cte}
     SELECT to_char(tord.biz_date, 'YYYY-MM-DD') AS biz_date,
            tord.time_of_day, tord.driver_id, tord.driver_name,
            o."restaurantName" AS restaurant_name,
            ol."productName" AS product_name, ol."uomName" AS uom_name,
            SUM(COALESCE(ol."deliveredQty", 0))::float AS delivered_qty,
            SUM(ol."unitPrice" * COALESCE(ol."deliveredQty", 0))::float AS delivered_subtotal
     FROM trip_order tord
     JOIN "Order" o ON o.id = tord.order_id
     JOIN "OrderLine" ol ON ol."orderId" = o.id
     WHERE ol."isGift" = false
     GROUP BY tord.biz_date, tord.time_of_day, tord.driver_id, tord.driver_name,
              o."restaurantName", ol."productName", ol."uomName"
     ORDER BY tord.biz_date DESC, tord.time_of_day, tord.driver_name, o."restaurantName", ol."productName"
     LIMIT ${detailLimit + 1}`,
    ...params,
  )) as Array<Record<string, unknown>>

  const truncated = rows.length > detailLimit
  const detail: DriverProductDetailRow[] = rows.slice(0, detailLimit).map((r) => {
    const qty = num(r.delivered_qty)
    const subtotal = round2(num(r.delivered_subtotal))
    return {
      bizDate: String(r.biz_date),
      timeOfDay: r.time_of_day == null ? null : String(r.time_of_day),
      driverId: r.driver_id == null ? null : String(r.driver_id),
      driverName: String(r.driver_name),
      restaurantName: String(r.restaurant_name ?? ''),
      productName: String(r.product_name),
      uomName: r.uom_name == null ? null : String(r.uom_name),
      deliveredQty: round2(qty),
      avgUnitPrice: qty > 0 ? round2(subtotal / qty) : 0,
      deliveredSubtotal: subtotal,
    }
  })

  return { rows: detail, truncated }
}

/**
 * 明细导出成 CSV，字段与 fetchDriverProductDetail 一一对应。放在 lib 里而不是页面里，
 * 理由同 detailToCsv —— 导出的数字必须来自同一个结果对象，能单测。
 */
export function productDetailToCsv(rows: DriverProductDetailRow[]): string {
  const head = ['日期', '时段', '司机', '客户', '产品', '单位', '送达数量', '均价', '送达金额']
  // 20260922 code review：裸 \r（无配对 \n）不转义会拼出畸形 CSV 行，
  // 跟 lib/csv-export.ts 的 escapeCell 对齐，加上 \r
  const esc = (v: string | number | null) => {
    const s = String(v ?? '')
    return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
  }
  const timeOfDayLabel = (t: string | null) => (t === 'am' ? '上午' : t === 'pm' ? '下午' : '—')
  const lines = rows.map(r => [
    r.bizDate, timeOfDayLabel(r.timeOfDay), r.driverName, r.restaurantName, r.productName,
    r.uomName ?? '', r.deliveredQty, r.avgUnitPrice, r.deliveredSubtotal,
  ].map(esc).join(','))
  return '﻿' + [head.join(','), ...lines].join('\n')
}

export interface DriverDaySalesRow {
  driverId: string | null
  driverName: string
  totalIncTax: number
  revenueExTax: number
  grossProfit: number
  commissionTotal: number
}

/**
 * 「按司机」销售额+毛利+提成汇总（20260914，Sales Analysis 页的天粒度钻取用）。
 * ============================================================================
 * 归属复用 baseCte 的 Trip→订单展开（跟提成计算同一套口径，不会出现"提成报表跑了
 * 8 趟、这里 6 趟"的分叉，见文件头部大注释）。
 *
 * ⛔ 计数基准是 deliveredQty（送达口径），不是 orderedQty（销售口径，margin 路由用的
 * 那个）——司机对"实际送到手上的"负责，日期口径也是 waveDate（送货日）而不是
 * confirmationDate（确认日），跟本页其余"按天"面板不是同一批订单，UI 上要分清楚。
 * 毛利成本查法（v_lot_daily_cost → standardPrice 兜底、按 ProductSaleUom.factor 换算基准单位）
 * 与 app/api/analytics/margin/route.ts 逐字一致，含税换算与其 TAX_FRACTION_EXPR 一致。
 */
export async function fetchDriverDaySales(db: Db, start: Date, end: Date): Promise<DriverDaySalesRow[]> {
  const cte = baseCte({ byId: false, byName: false })
  const taxFrac = `(CASE WHEN COALESCE(ol."taxRate", 0) > 1 THEN COALESCE(ol."taxRate", 0) / 100.0 ELSE COALESCE(ol."taxRate", 0) END)`
  const sql = `${cte},
  cost_agg AS (
    SELECT ol."orderId" AS order_id,
           SUM(ol."unitPrice" * COALESCE(ol."deliveredQty", 0) * (1 + ${taxFrac}))::float AS total_inc_tax,
           SUM(ol."unitPrice" * COALESCE(ol."deliveredQty", 0))::float AS revenue_ex,
           SUM(COALESCE(lc.unit_cost, p."standardPrice", 0) * COALESCE(ol."deliveredQty", 0) * COALESCE(psu.factor, 1))::float AS cost
    FROM "OrderLine" ol
    JOIN order_calc oc2 ON oc2.order_id = ol."orderId"
    LEFT JOIN "Product" p ON p.id = ol."productId"
    LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
    LEFT JOIN LATERAL (
      SELECT c.unit_cost FROM v_lot_daily_cost c
      WHERE c.product_id = ol."productId" AND c.cost_date <= oc2.biz_date
      ORDER BY c.cost_date DESC LIMIT 1
    ) lc ON TRUE
    WHERE ol."isGift" = false
    GROUP BY ol."orderId"
  )
  SELECT oc.driver_id, oc.driver_name,
         SUM(COALESCE(ca.total_inc_tax, 0))::float AS total_inc_tax,
         SUM(COALESCE(ca.revenue_ex, 0))::float AS revenue_ex,
         SUM(COALESCE(ca.revenue_ex, 0) - COALESCE(ca.cost, 0))::float AS gross_profit,
         SUM(${TOTAL_EXPR})::float AS commission_total
  FROM order_calc oc
  LEFT JOIN cost_agg ca ON ca.order_id = oc.order_id
  GROUP BY oc.driver_id, oc.driver_name
  ORDER BY SUM(COALESCE(ca.total_inc_tax, 0)) DESC`

  const rows = (await db.$queryRawUnsafe(sql, start, end)) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    driverId: r.driver_id == null ? null : String(r.driver_id),
    driverName: String(r.driver_name),
    totalIncTax: round2(num(r.total_inc_tax)),
    revenueExTax: round2(num(r.revenue_ex)),
    grossProfit: round2(num(r.gross_profit)),
    commissionTotal: round2(num(r.commission_total)),
  }))
}

/**
 * 「按司机」销售额+毛利+提成汇总 —— 订单口径（20260916 起 Sales Analysis 页在用）。
 * ============================================================================
 * ## 为什么不再走 Trip
 *
 * `fetchDriverDaySales`（Trip 口径，保留在上面）在生产上**查不出任何东西**：Trip 只在
 * 波次点「确认出发」时生成（app/api/waves/[id]/dispatch → lib/trip-from-wave.ts），
 * 而生产库实测 8 月起 31 个波次 `dispatchedAt` 全为 null，整库只有 8 条 Trip、最晚
 * 2026-07-04，其中 7 条是 PENDING——又正好被 baseCte 的 `t.status <> 'PENDING'` 滤掉。
 * 结果就是"随便点开哪天，按司机面板都是空的"。
 *
 * 所以这里换成订单自己的归属：**优先所属波次的司机**（波次唯一性 = 司机+时段，
 * 见 schema PickingWave 注释），订单不在任何波次时回落到 `Order.driverSlotId`
 * （下单时的派车意向）。这与订单详情页 `currentDriverSlotId` 的取值顺序同源，
 * 区别是这里只解析到波次级、不细分到托盘级——同一波次跨托盘换司机的情况这里会算作一个人。
 *
 * ## 计数基准
 *
 * 销售额/毛利用 **orderedQty**（与 margin 路由逐字一致），这样这张表按司机加总 =
 * 左侧那一行的当日金额，两张表能对上；Trip 那版用 deliveredQty，司机未回单时全是 0。
 * 提成仍按 **deliveredQty**——提成本来就只认实送量（与 lib/commission.ts 同公式），
 * 所以未送达的单提成为 0 是正确表现，不是漏算。
 * 日期口径 = COALESCE(deliveryDate, confirmationDate)，与本页其余面板（dateBasis=delivery）同口径。
 */
export async function fetchDriverDaySalesByOrder(db: Db, start: Date, end: Date): Promise<DriverDaySalesRow[]> {
  const statusSql = SALES_COUNTED_STATUSES.map((x) => `'${x}'`).join(', ')
  const taxFrac = `(CASE WHEN COALESCE(ol."taxRate", 0) > 1 THEN COALESCE(ol."taxRate", 0) / 100.0 ELSE COALESCE(ol."taxRate", 0) END)`
  const bizDate = `COALESCE(o."deliveryDate", o."confirmationDate")`
  const sql = `
  WITH scoped AS (
    SELECT o.id                                                              AS order_id,
           COALESCE(NULLIF(w."driverName", ''), NULLIF(ds."driverName", ''), '未指定') AS driver_name,
           ds."userId"                                                       AS driver_user_id,
           COALESCE(${bizDate}, o."createdAt")                               AS biz_date,
           COALESCE(o."commissionFixed", 0)                                  AS commission_fixed,
           COALESCE(o."commissionRate", 0)                                   AS commission_rate
    FROM "Order" o
    LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
    LEFT JOIN LATERAL (
      SELECT pw."driverName"
      FROM "PickingWave" pw
      WHERE o.id = ANY(pw."orderIds")
      ORDER BY pw."dispatchedAt" DESC NULLS LAST, pw."createdAt" DESC
      LIMIT 1
    ) w ON TRUE
    WHERE o.status::text IN (${statusSql})
      AND ${bizDate} >= $1::timestamp
      AND ${bizDate} <  $2::timestamp
  ),
  line_agg AS (
    SELECT ol."orderId" AS order_id,
           SUM(ol.subtotal)::float                                                                AS revenue_ex,
           SUM(ol.subtotal * (1 + ${taxFrac}))::float                                             AS total_inc_tax,
           SUM(COALESCE(lc.unit_cost, p."standardPrice", 0) * ol."orderedQty" * COALESCE(psu.factor, 1))::float AS cost,
           SUM(COALESCE(ol."commissionPrice", 0) * COALESCE(ol."deliveredQty", 0))::float         AS comm_item,
           SUM(COALESCE(ol."unitPrice", 0) * COALESCE(ol."deliveredQty", 0))::float               AS delivered_subtotal,
           SUM(COALESCE(ol."deliveredQty", 0))::float                                             AS delivered_qty
    FROM "OrderLine" ol
    JOIN scoped sc ON sc.order_id = ol."orderId"
    LEFT JOIN "Product" p ON p.id = ol."productId"
    LEFT JOIN "ProductSaleUom" psu ON psu."productId" = ol."productId" AND psu."uomId" = ol."uomId"
    LEFT JOIN LATERAL (
      SELECT c.unit_cost FROM v_lot_daily_cost c
      WHERE c.product_id = ol."productId" AND c.cost_date <= sc.biz_date::date
      ORDER BY c.cost_date DESC LIMIT 1
    ) lc ON TRUE
    WHERE ol."isGift" = false
    GROUP BY ol."orderId"
  )
  SELECT sc.driver_name,
         MAX(sc.driver_user_id)                                                       AS driver_id,
         SUM(COALESCE(la.total_inc_tax, 0))::float                                     AS total_inc_tax,
         SUM(COALESCE(la.revenue_ex, 0))::float                                        AS revenue_ex,
         SUM(COALESCE(la.revenue_ex, 0) - COALESCE(la.cost, 0))::float                 AS gross_profit,
         SUM(COALESCE(la.comm_item, 0)
             + CASE WHEN COALESCE(la.delivered_qty, 0) > 0 THEN sc.commission_fixed ELSE 0 END
             + COALESCE(la.delivered_subtotal, 0) * sc.commission_rate)::float         AS commission_total
  FROM scoped sc
  LEFT JOIN line_agg la ON la.order_id = sc.order_id
  GROUP BY sc.driver_name
  ORDER BY SUM(COALESCE(la.total_inc_tax, 0)) DESC`

  // deliveryDate/confirmationDate 都是无时区 timestamp，存的是都柏林墙上时间——
  // 必须按裸字符串绑参，否则会被当 timestamptz 再换算一次（见 metrics.ts toNaiveTimestampParam）
  const rows = (await db.$queryRawUnsafe(
    sql, toNaiveTimestampParam(start), toNaiveTimestampParam(end),
  )) as Array<Record<string, unknown>>
  return rows.map((r) => ({
    driverId: r.driver_id == null ? null : String(r.driver_id),
    driverName: String(r.driver_name),
    totalIncTax: round2(num(r.total_inc_tax)),
    revenueExTax: round2(num(r.revenue_ex)),
    grossProfit: round2(num(r.gross_profit)),
    commissionTotal: round2(num(r.commission_total)),
  }))
}
