/**
 * 灵活数据分析 · 透视引擎（纯函数，无 DB 依赖）
 * ============================================================================
 * 只负责把 SQL 按 (行, 列) 两级 GROUP BY 出来的扁平结果，整理成前端可直接渲染的
 * 矩阵结构（行头+行小计、列头+列小计、扁平 cell 列表、总计）。
 * SQL 怎么查、维度白名单怎么拼，见调用方 app/api/analytics/margin/route.ts。
 * 设计文档：docs/20260731-flexible-pivot-analysis-design.md
 */

export interface DimensionDef {
  keyExpr: string
  nameExpr: string
  extraJoin: string
  isTimeBucket: boolean
}

/**
 * 时间维度（日/周/月/季/年）挂在哪个日期列上。
 *
 * confirmation = Order.confirmationDate（订单确认日），analytics 全域历史口径，毛利分析页/AI 问数在用。
 * delivery     = Order.deliveryDate（送货日），销售钻取页在用。
 *
 * ⛔ 两者在生产上差得很远：客户是「先送货、事后补录确认」的作业方式，实测 2026-09-13
 * 送货的 6 张单里有 3 张拖到 09-16 凌晨才确认——按确认日统计会把它们甩进下一周，
 * 看上去就是「当天漏了一半的单」。deliveryDate 可空（未排程的单），COALESCE 回落到
 * 确认日，避免这批单直接从统计里消失。
 */
export type DateBasis = 'confirmation' | 'delivery'

export const DATE_BASIS_EXPR: Record<DateBasis, string> = {
  confirmation: `o."confirmationDate"`,
  delivery: `COALESCE(o."deliveryDate", o."confirmationDate")`,
}

/**
 * 行/列维度白名单——所有 SQL 片段均为代码里写死的常量，禁止拼接任何请求参数进 SQL 文本。
 * basis 只能取 DATE_BASIS_EXPR 的键，同样不接受请求参数直接入 SQL。
 */
/**
 * 司机归属：波次上的司机名优先，回落到订单的派车意向 DriverSlot，都没有则「未指定」。
 * 与 driver-commission.ts 同一套写法，两处要一起改。
 */
export const DRIVER_NAME_EXPR = `COALESCE(NULLIF(w."driverName", ''), NULLIF(ds."driverName", ''), '未指定')`
/**
 * ⛔ 这里**不要**用 driver-commission.ts 那种 `LEFT JOIN LATERAL … WHERE o.id = ANY(pw."orderIds")`。
 * 那边的 LATERAL 挂在**订单**粒度的 CTE 里，一单求值一次；而本文件的维度 JOIN 是拼进
 * **订单行**粒度的查询的，同一单的每一行都要再求值一次。
 *
 * 生产实测（20260920，400 天范围 / 33 万行）：LATERAL 写法 **1194ms**，
 * 换成下面这种「把 orderIds 一次性 unnest 开、再普通 LEFT JOIN」**407ms**，
 * 快 2.9 倍，12 个司机的金额逐个对过、完全一致。
 * PickingWave 只有 76 行，整表展开的代价可以忽略；贵的是被求值 3 万多次这件事本身。
 */
export const DRIVER_JOIN = `LEFT JOIN "DriverSlot" ds ON ds.id = o."driverSlotId"
         LEFT JOIN (
           SELECT DISTINCT ON (x.oid) x.oid, x."driverName"
           FROM (
             SELECT unnest(pw."orderIds") AS oid, pw."driverName", pw."dispatchedAt", pw."createdAt"
             FROM "PickingWave" pw
           ) x
           ORDER BY x.oid, x."dispatchedAt" DESC NULLS LAST, x."createdAt" DESC
         ) w ON w.oid = o.id`

export function dimensionDefs(basis: DateBasis = 'confirmation'): Record<string, DimensionDef> {
  const d = DATE_BASIS_EXPR[basis]
  return {
    product: {
      keyExpr: `ol."productId"`,
      nameExpr: `MAX(ol."productName")`,
      extraJoin: '',
      isTimeBucket: false,
    },
    category: {
      keyExpr: `COALESCE(cat.id, 'uncategorized')`,
      nameExpr: `COALESCE(MAX(COALESCE(cat."nameZh", cat.name)), '未分类')`,
      extraJoin: `LEFT JOIN "ProductCategory" cat ON cat.id = p."categoryId"`,
      isTimeBucket: false,
    },
    customer: {
      keyExpr: `o."restaurantId"`,
      nameExpr: `MAX(o."restaurantName")`,
      extraJoin: '',
      isTimeBucket: false,
    },
    salesUser: {
      keyExpr: `COALESCE(o."salesUserId", 'none')`,
      nameExpr: `COALESCE(MAX(su.name), '未指定业务员')`,
      extraJoin: `LEFT JOIN "User" su ON su.id = o."salesUserId"`,
      isTimeBucket: false,
    },
    /**
     * 20260920 新增。归属口径与 lib/analytics/driver-commission.ts:fetchDriverDaySalesByOrder
     * **逐字一致**：所属波次的司机优先，订单不在任何波次时回落 Order.driverSlotId
     * （下单时的派车意向），都没有则「未指定」。
     *
     * ⛔ 不要改成走 Trip 表：生产库 Trip 自 20260704 起就不再生成（波次没人点「确认出发」），
     * 基于 Trip 的按司机统计恒为空。
     * ⛔ key 用**司机名**而不是 id：DriverSlot.userId 大量为空，而波次上只存了 driverName。
     * 改名只对未来生效、快照保留旧名，所以同一个人改名前后会是两行——这与提成报表同病，
     * 不在本次处理范围。
     */
    driver: {
      keyExpr: DRIVER_NAME_EXPR,
      nameExpr: `MAX(${DRIVER_NAME_EXPR})`,
      extraJoin: DRIVER_JOIN,
      isTimeBucket: false,
    },
    day: {
      keyExpr: `to_char(date_trunc('day', ${d}), 'YYYY-MM-DD')`,
      nameExpr: `MAX(to_char(date_trunc('day', ${d}), 'YYYY-MM-DD'))`,
      extraJoin: '',
      isTimeBucket: true,
    },
    week: {
      keyExpr: `to_char(date_trunc('week', ${d}), 'IYYY-"W"IW')`,
      nameExpr: `MAX(to_char(date_trunc('week', ${d}), 'IYYY-"W"IW'))`,
      extraJoin: '',
      isTimeBucket: true,
    },
    month: {
      keyExpr: `to_char(date_trunc('month', ${d}), 'YYYY-MM')`,
      nameExpr: `MAX(to_char(date_trunc('month', ${d}), 'YYYY-MM'))`,
      extraJoin: '',
      isTimeBucket: true,
    },
    // 20260915：销售钻取新增按季/按年，格式跟 week 的 'IYYY-"W"IW' 同一套写法
    quarter: {
      keyExpr: `to_char(date_trunc('quarter', ${d}), 'YYYY-"Q"Q')`,
      nameExpr: `MAX(to_char(date_trunc('quarter', ${d}), 'YYYY-"Q"Q'))`,
      extraJoin: '',
      isTimeBucket: true,
    },
    year: {
      keyExpr: `to_char(date_trunc('year', ${d}), 'YYYY')`,
      nameExpr: `MAX(to_char(date_trunc('year', ${d}), 'YYYY'))`,
      extraJoin: '',
      isTimeBucket: true,
    },
  }
}

/** 历史默认口径（确认日），毛利分析页 / AI 问数等既有调用方保持不变 */
export const DIMENSION_DEFS: Record<string, DimensionDef> = dimensionDefs('confirmation')

/** 前端行/列维度下拉的展示顺序与文案（顺序即 UI 顺序） */
export const DIMENSION_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'product', label: '商品' },
  { key: 'category', label: '分类' },
  { key: 'customer', label: '客户' },
  { key: 'salesUser', label: '业务员' },
  { key: 'driver', label: '司机' },
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
  { key: 'quarter', label: '季' },
  { key: 'year', label: '年' },
]

export const PIVOT_MAX_COLS = 60

export class PivotTooManyColumnsError extends Error {
  columnCount: number
  constructor(columnCount: number) {
    super(`列数过多（${columnCount} 列），请缩短日期范围或改用周/月分桶`)
    this.name = 'PivotTooManyColumnsError'
    this.columnCount = columnCount
  }
}

export interface PivotMeasures {
  revenueExTax: number
  cost: number
  grossProfit: number
  marginPct: number
  qty: number
}

export interface PivotRawCell {
  rowKey: string
  rowName: string
  colKey: string
  colName: string
  qty: number
  revenueExTax: number
  cost: number
  grossProfit: number
}

export interface PivotHeader {
  key: string
  name: string
  subtotal: PivotMeasures
}

export interface PivotCell extends PivotMeasures {
  rowKey: string
  colKey: string
}

export interface PivotResult {
  rows: PivotHeader[]
  cols: PivotHeader[]
  cells: PivotCell[]
  grandTotal: PivotMeasures
}

interface Accumulator {
  name: string
  qty: number
  revenueExTax: number
  cost: number
  grossProfit: number
}

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000
}

function marginPctOf(revenueExTax: number, grossProfit: number): number {
  return revenueExTax > 0 ? round2((grossProfit / revenueExTax) * 100) : 0
}

function accumulate(map: Map<string, Accumulator>, key: string, name: string, cell: PivotRawCell): void {
  const existing = map.get(key)
  if (existing) {
    existing.qty += cell.qty
    existing.revenueExTax += cell.revenueExTax
    existing.cost += cell.cost
    existing.grossProfit += cell.grossProfit
  } else {
    map.set(key, { name, qty: cell.qty, revenueExTax: cell.revenueExTax, cost: cell.cost, grossProfit: cell.grossProfit })
  }
}

function toHeaders(map: Map<string, Accumulator>, isTimeBucket: boolean): PivotHeader[] {
  const entries: PivotHeader[] = Array.from(map.entries()).map(([key, v]) => ({
    key,
    name: v.name,
    subtotal: {
      qty: round3(v.qty),
      revenueExTax: round2(v.revenueExTax),
      cost: round2(v.cost),
      grossProfit: round2(v.grossProfit),
      marginPct: marginPctOf(v.revenueExTax, v.grossProfit),
    },
  }))
  if (isTimeBucket) {
    entries.sort((a, b) => a.key.localeCompare(b.key))
  } else {
    entries.sort((a, b) => b.subtotal.revenueExTax - a.subtotal.revenueExTax)
  }
  return entries
}

/**
 * 把 (行, 列) 两级 GROUP BY 出来的扁平 SQL 结果整理成矩阵。
 * rowIsTimeBucket/colIsTimeBucket 决定对应轴按时间正序还是按销售额降序排列。
 * 列数（distinct colKey）超过 PIVOT_MAX_COLS 时抛 PivotTooManyColumnsError，调用方转 400。
 */
export function buildPivot(
  raw: PivotRawCell[],
  opts: { rowIsTimeBucket: boolean; colIsTimeBucket: boolean },
): PivotResult {
  const colKeySet = new Set(raw.map((r) => r.colKey))
  if (colKeySet.size > PIVOT_MAX_COLS) {
    throw new PivotTooManyColumnsError(colKeySet.size)
  }

  const rowMap = new Map<string, Accumulator>()
  const colMap = new Map<string, Accumulator>()
  const grand = { qty: 0, revenueExTax: 0, cost: 0, grossProfit: 0 }

  for (const cellItem of raw) {
    accumulate(rowMap, cellItem.rowKey, cellItem.rowName, cellItem)
    accumulate(colMap, cellItem.colKey, cellItem.colName, cellItem)
    grand.qty += cellItem.qty
    grand.revenueExTax += cellItem.revenueExTax
    grand.cost += cellItem.cost
    grand.grossProfit += cellItem.grossProfit
  }

  const cells: PivotCell[] = raw.map((c) => ({
    rowKey: c.rowKey,
    colKey: c.colKey,
    qty: round3(c.qty),
    revenueExTax: round2(c.revenueExTax),
    cost: round2(c.cost),
    grossProfit: round2(c.grossProfit),
    marginPct: marginPctOf(c.revenueExTax, c.grossProfit),
  }))

  return {
    rows: toHeaders(rowMap, opts.rowIsTimeBucket),
    cols: toHeaders(colMap, opts.colIsTimeBucket),
    cells,
    grandTotal: {
      qty: round3(grand.qty),
      revenueExTax: round2(grand.revenueExTax),
      cost: round2(grand.cost),
      grossProfit: round2(grand.grossProfit),
      marginPct: marginPctOf(grand.revenueExTax, grand.grossProfit),
    },
  }
}
