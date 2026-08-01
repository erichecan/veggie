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

/** 行/列维度白名单——所有 SQL 片段均为代码里写死的常量，禁止拼接任何请求参数进 SQL 文本 */
export const DIMENSION_DEFS: Record<string, DimensionDef> = {
  product: {
    keyExpr: `ol."productId"`,
    nameExpr: `MAX(ol."productName")`,
    extraJoin: '',
    isTimeBucket: false,
  },
  category: {
    keyExpr: `COALESCE(cat.id, 'uncategorized')`,
    nameExpr: `COALESCE(MAX(COALESCE(cat."nameZh", cat.name)), '未分类')`,
    extraJoin: `LEFT JOIN "ProductCategory" cat ON cat.id = COALESCE(p."categoryId", pt."categoryId")`,
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
  day: {
    keyExpr: `to_char(date_trunc('day', o."confirmationDate"), 'YYYY-MM-DD')`,
    nameExpr: `MAX(to_char(date_trunc('day', o."confirmationDate"), 'YYYY-MM-DD'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  week: {
    keyExpr: `to_char(date_trunc('week', o."confirmationDate"), 'IYYY-"W"IW')`,
    nameExpr: `MAX(to_char(date_trunc('week', o."confirmationDate"), 'IYYY-"W"IW'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
  month: {
    keyExpr: `to_char(date_trunc('month', o."confirmationDate"), 'YYYY-MM')`,
    nameExpr: `MAX(to_char(date_trunc('month', o."confirmationDate"), 'YYYY-MM'))`,
    extraJoin: '',
    isTimeBucket: true,
  },
}

/** 前端行/列维度下拉的展示顺序与文案（顺序即 UI 顺序） */
export const DIMENSION_OPTIONS: Array<{ key: string; label: string }> = [
  { key: 'product', label: '商品' },
  { key: 'category', label: '分类' },
  { key: 'customer', label: '客户' },
  { key: 'salesUser', label: '业务员' },
  { key: 'day', label: '日' },
  { key: 'week', label: '周' },
  { key: 'month', label: '月' },
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
