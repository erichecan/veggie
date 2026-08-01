# 毛利分析透视模式 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把「毛利分析」页从"一次只能选一个分组维度"升级成支持行×列两维交叉的透视表，外加时间桶维度、三个筛选下拉和 CSV 导出。

**Architecture:** 新增一个纯函数模块 `lib/analytics/pivot.ts` 承担维度白名单 + 矩阵整理逻辑（可单测，不碰 DB）；`app/api/analytics/margin/route.ts` 在原有单维度 SQL 基础上加一个可选的第二维度 `colBy` 和三个可选过滤参数，不传 `colBy` 时行为完全不变；前端新增 `PivotView.tsx` 承载透视模式的全部 UI，`page.tsx` 只加一个模式切换开关。

**Tech Stack:** Next.js App Router + Prisma（`$queryRawUnsafe` 白名单拼接，同现有 `margin` 路由风格）+ TypeScript + Tailwind；测试用 `node --test --import=tsx`。

## Global Constraints

- 所有 SQL 维度片段（keyExpr/nameExpr/extraJoin）必须是代码里写死的常量，禁止把请求参数拼进 SQL 文本；用户可控的过滤值（categoryId/customerId/salesUserId）一律走 `$n` 参数化。
- 不传 `colBy` 时，`/api/analytics/margin` 的请求/响应必须和改造前逐字节一致（零回归）。
- 权限沿用现有 `['BOSS', 'OPERATOR', 'FINANCE']`，不新增/不放宽。
- 列数（distinct colKey）超过 60 时后端必须 400，不允许静默截断或前端硬撑渲染。
- 金额四舍五入到分（2 位小数）、数量到 3 位小数、百分比到 1 位小数——沿用现有 `round2`/`round3` 口径，不引入新的精度规则。
- 设计依据：`docs/20260731-flexible-pivot-analysis-design.md`。

---

### Task 1: 透视引擎纯函数 `lib/analytics/pivot.ts`

**Files:**
- Create: `lib/analytics/pivot.ts`
- Test: `tests/analytics-pivot.test.ts`

**Interfaces:**
- Produces（后续 Task 2/3 依赖的确切签名）：
  - `DIMENSION_DEFS: Record<string, DimensionDef>`，`DimensionDef = { keyExpr: string; nameExpr: string; extraJoin: string; isTimeBucket: boolean }`，key 集合固定为 `product | category | customer | salesUser | day | week | month`
  - `DIMENSION_OPTIONS: Array<{ key: string; label: string }>`，顺序：商品/分类/客户/业务员/日/周/月
  - `PIVOT_MAX_COLS: number`（60）
  - `class PivotTooManyColumnsError extends Error { columnCount: number }`
  - `interface PivotRawCell { rowKey: string; rowName: string; colKey: string; colName: string; qty: number; revenueExTax: number; cost: number; grossProfit: number }`
  - `interface PivotMeasures { revenueExTax: number; cost: number; grossProfit: number; marginPct: number; qty: number }`
  - `interface PivotHeader { key: string; name: string; subtotal: PivotMeasures }`
  - `interface PivotCell extends PivotMeasures { rowKey: string; colKey: string }`
  - `interface PivotResult { rows: PivotHeader[]; cols: PivotHeader[]; cells: PivotCell[]; grandTotal: PivotMeasures }`
  - `function buildPivot(raw: PivotRawCell[], opts: { rowIsTimeBucket: boolean; colIsTimeBucket: boolean }): PivotResult`（列数超限抛 `PivotTooManyColumnsError`）

- [ ] **Step 1: 写失败测试 `tests/analytics-pivot.test.ts`**

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildPivot, DIMENSION_DEFS, DIMENSION_OPTIONS, PIVOT_MAX_COLS, PivotTooManyColumnsError,
  type PivotRawCell,
} from '../lib/analytics/pivot'

test('DIMENSION_DEFS 覆盖 7 个维度，时间桶维度标记正确', () => {
  const keys = Object.keys(DIMENSION_DEFS).sort()
  assert.deepEqual(keys, ['category', 'customer', 'day', 'month', 'product', 'salesUser', 'week'])
  assert.equal(DIMENSION_DEFS.day.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.week.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.month.isTimeBucket, true)
  assert.equal(DIMENSION_DEFS.product.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.category.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.customer.isTimeBucket, false)
  assert.equal(DIMENSION_DEFS.salesUser.isTimeBucket, false)
})

test('DIMENSION_OPTIONS 顺序与 DIMENSION_DEFS 一一对应，供前端下拉直接渲染', () => {
  const optionKeys = DIMENSION_OPTIONS.map((o) => o.key).sort()
  const defKeys = Object.keys(DIMENSION_DEFS).sort()
  assert.deepEqual(optionKeys, defKeys)
})

test('空数组 → 全零结果，不除以零', () => {
  const result = buildPivot([], { rowIsTimeBucket: false, colIsTimeBucket: false })
  assert.deepEqual(result, {
    rows: [], cols: [], cells: [],
    grandTotal: { qty: 0, revenueExTax: 0, cost: 0, grossProfit: 0, marginPct: 0 },
  })
})

function cell(rowKey: string, rowName: string, colKey: string, colName: string, revenueExTax: number, cost: number, qty: number): PivotRawCell {
  return { rowKey, rowName, colKey, colName, revenueExTax, cost, qty, grossProfit: revenueExTax - cost }
}

test('2x2 矩阵：行/列小计和总计按业务维度正确累加', () => {
  const raw: PivotRawCell[] = [
    cell('cust_a', 'A 客户', 'p_1', '洋葱', 100, 60, 10),
    cell('cust_a', 'A 客户', 'p_2', '土豆', 50, 40, 5),
    cell('cust_b', 'B 客户', 'p_1', '洋葱', 200, 120, 20),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: false })

  assert.deepEqual(result.rows.map((r) => r.key), ['cust_b', 'cust_a'])
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.revenueExTax, 150)
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.grossProfit, 30)
  assert.equal(result.rows.find((r) => r.key === 'cust_a')!.subtotal.marginPct, 20)

  assert.deepEqual(result.cols.map((c) => c.key), ['p_1', 'p_2'])
  assert.equal(result.cols.find((c) => c.key === 'p_1')!.subtotal.revenueExTax, 300)

  assert.equal(result.grandTotal.revenueExTax, 350)
  assert.equal(result.grandTotal.grossProfit, 130)
  assert.equal(result.grandTotal.qty, 35)

  const cellAP1 = result.cells.find((c) => c.rowKey === 'cust_a' && c.colKey === 'p_1')!
  assert.equal(cellAP1.revenueExTax, 100)
  assert.equal(cellAP1.grossProfit, 40)
  assert.equal(cellAP1.marginPct, 40)
})

test('时间桶维度按 key 字典序（即时间正序）排列，不按销售额排', () => {
  const raw: PivotRawCell[] = [
    cell('cust_a', 'A 客户', '2026-03', '2026年3月', 500, 300, 1),
    cell('cust_a', 'A 客户', '2026-01', '2026年1月', 10, 5, 1),
    cell('cust_a', 'A 客户', '2026-02', '2026年2月', 100, 50, 1),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: true })
  assert.deepEqual(result.cols.map((c) => c.key), ['2026-01', '2026-02', '2026-03'])
})

test('行是时间桶时同样按时间正序，不受销售额影响', () => {
  const raw: PivotRawCell[] = [
    cell('2026-03', '3月', 'cust_a', 'A', 500, 300, 1),
    cell('2026-01', '1月', 'cust_a', 'A', 10, 5, 1),
  ]
  const result = buildPivot(raw, { rowIsTimeBucket: true, colIsTimeBucket: false })
  assert.deepEqual(result.rows.map((r) => r.key), ['2026-01', '2026-03'])
})

test('distinct 列数超过 PIVOT_MAX_COLS(60) 时抛出 PivotTooManyColumnsError', () => {
  const raw: PivotRawCell[] = Array.from({ length: PIVOT_MAX_COLS + 1 }, (_, i) =>
    cell('cust_a', 'A', `d_${i}`, `day ${i}`, 10, 5, 1))
  assert.throws(
    () => buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: true }),
    (err: unknown) => err instanceof PivotTooManyColumnsError && err.columnCount === PIVOT_MAX_COLS + 1,
  )
})

test('单元格销售额为 0 时毛利率记 0，不是 NaN/Infinity', () => {
  const raw: PivotRawCell[] = [cell('cust_a', 'A', 'p_1', '洋葱', 0, 0, 0)]
  const result = buildPivot(raw, { rowIsTimeBucket: false, colIsTimeBucket: false })
  assert.equal(result.cells[0].marginPct, 0)
  assert.equal(result.rows[0].subtotal.marginPct, 0)
})
```

- [ ] **Step 2: 运行测试确认失败**

Run: `node --test --import=tsx tests/analytics-pivot.test.ts`
Expected: FAIL，报错 `Cannot find module '../lib/analytics/pivot'`

- [ ] **Step 3: 实现 `lib/analytics/pivot.ts`**

```typescript
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
```

- [ ] **Step 4: 运行测试确认全部通过**

Run: `node --test --import=tsx tests/analytics-pivot.test.ts`
Expected: PASS，9 个测试全绿

- [ ] **Step 5: Commit**

```bash
git add lib/analytics/pivot.ts tests/analytics-pivot.test.ts
git commit -m "$(cat <<'EOF'
feat(analytics): add pure pivot engine for margin analysis

Whitelisted dimension defs (product/category/customer/salesUser/day/week/
month) plus buildPivot() to shape flat (row,col) SQL results into a
matrix with row/col subtotals and a grand total. Guards against runaway
column counts (>60) with PivotTooManyColumnsError.
EOF
)"
```

---

### Task 2: `/api/analytics/margin` 加 `colBy` + 过滤参数

**Files:**
- Modify: `app/api/analytics/margin/route.ts`（整体重写，见下方完整内容）

**Interfaces:**
- Consumes: `DIMENSION_DEFS`、`buildPivot`、`PivotTooManyColumnsError`、`PivotRawCell`（来自 Task 1 的 `lib/analytics/pivot.ts`）
- Produces：
  - 不传 `colBy`：`{ summary, rows: Array<{key,name,lineCount,qty,revenueExTax,cost,grossProfit,marginPct,costCoverage}> }`（与改造前逐字节一致）
  - 传 `colBy`：`{ summary, rows: PivotHeader[], cols: PivotHeader[], cells: PivotCell[], grandTotal: PivotMeasures }`
  - 新查询参数：`colBy`（可选）、`categoryId`/`customerId`/`salesUserId`（可选，精确匹配）
  - 校验失败：`groupBy`/`colBy` 不在白名单 → 400；`colBy === groupBy` → 400「行列维度不能相同」；列数超限 → 400（message 来自 `PivotTooManyColumnsError`）

- [ ] **Step 1: 用整体重写替换 `app/api/analytics/margin/route.ts`**

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'
import { DIMENSION_DEFS, buildPivot, PivotTooManyColumnsError, type PivotRawCell } from '@/lib/analytics/pivot'

/**
 * /api/analytics/margin — 毛利分析
 * ============================================================================
 * GET ?from&to&groupBy=product|category|customer|salesUser|day|week|month
 *     &colBy=<同上，可选，传了就是透视模式>
 *     &categoryId&customerId&salesUserId（可选精确过滤）
 * 毛利口径（税前）：Σ (unitPrice − unitCostRef) × orderedQty
 * unitCostRef 优先级：≤确认日最近的批次加权成本（v_lot_daily_cost）
 *                    → Product.standardPrice → Template.standardPrice → 0
 * 每行返回 costedAmount（有批次成本的金额），前端展示成本覆盖率。
 * 不传 colBy 时行为与透视模式改造前完全一致；透视设计见 docs/20260731-flexible-pivot-analysis-design.md
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

/**
 * 多单位销售(20260714)：ol."orderedQty" 按行选用单位计数，非商品"基准单位"(pt."uomId")时
 * 需要按 Uom.factor 比例换算成基准单位数量再参与 SUM，否则"箱"和"个"直接相加/相乘会失真。
 * 逻辑与 lib/inventory.ts 的 toStockQty 换算公式一致。
 */
const STOCK_QTY_EXPR = `(CASE WHEN ol."uomId" IS NOT NULL AND ol."uomId" <> pt."uomId"
       AND line_uom.factor IS NOT NULL AND anchor_uom.factor IS NOT NULL AND anchor_uom.factor <> 0
       THEN ol."orderedQty" * (line_uom.factor / anchor_uom.factor)
       ELSE ol."orderedQty" END)`

const round2 = (n: number) => Math.round(n * 100) / 100

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      const groupBy = searchParams.get('groupBy') ?? 'product'
      const colByParam = searchParams.get('colBy')
      const categoryId = searchParams.get('categoryId')
      const customerId = searchParams.get('customerId')
      const salesUserId = searchParams.get('salesUserId')

      const rowDef = DIMENSION_DEFS[groupBy]
      if (!rowDef) {
        return NextResponse.json({ error: `groupBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      const colBy = colByParam || null
      const colDef = colBy ? DIMENSION_DEFS[colBy] : null
      if (colBy && !colDef) {
        return NextResponse.json({ error: `colBy 必须是 ${Object.keys(DIMENSION_DEFS).join('/')}` }, { status: 400 })
      }
      if (colBy && colBy === groupBy) {
        return NextResponse.json({ error: '行列维度不能相同' }, { status: 400 })
      }

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const params: unknown[] = [start, end]
      const filters: string[] = []
      if (categoryId) { params.push(categoryId); filters.push(`COALESCE(p."categoryId", pt."categoryId") = $${params.length}`) }
      if (customerId) { params.push(customerId); filters.push(`o."restaurantId" = $${params.length}`) }
      if (salesUserId) { params.push(salesUserId); filters.push(`o."salesUserId" = $${params.length}`) }
      const extraWhere = filters.length ? ` AND ${filters.join(' AND ')}` : ''

      const colSelect = colDef ? `, ${colDef.keyExpr} AS col_key, ${colDef.nameExpr} AS col_name` : ''
      const colGroupBy = colDef ? `, ${colDef.keyExpr}` : ''
      const colJoin = colDef ? colDef.extraJoin : ''

      const rows = (await p.$queryRawUnsafe(
        `SELECT ${rowDef.keyExpr} AS row_key,
                ${rowDef.nameExpr} AS row_name
                ${colSelect},
                COUNT(*)::int AS line_count,
                SUM(${STOCK_QTY_EXPR})::float AS qty,
                SUM(ol.subtotal)::float AS revenue_ex,
                SUM(COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS cost,
                SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR})::float AS gross_profit,
                SUM(CASE WHEN lc.unit_cost IS NOT NULL THEN ol.subtotal ELSE 0 END)::float AS costed_amount
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         LEFT JOIN "Product" p ON p.id = ol."productId"
         LEFT JOIN "ProductTemplate" pt ON pt.id = p."templateId"
         LEFT JOIN "Uom" line_uom ON line_uom.id = ol."uomId"
         LEFT JOIN "Uom" anchor_uom ON anchor_uom.id = pt."uomId"
         ${rowDef.extraJoin}
         ${colJoin}
         LEFT JOIN LATERAL (
           SELECT c.unit_cost FROM v_lot_daily_cost c
           WHERE c.product_id = ol."productId"
             AND c.cost_date <= COALESCE(o."confirmationDate", o."createdAt")::date
           ORDER BY c.cost_date DESC LIMIT 1
         ) lc ON TRUE
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
           ${extraWhere}
         GROUP BY ${rowDef.keyExpr}${colGroupBy}
         ORDER BY SUM(ol.subtotal - COALESCE(lc.unit_cost, p."standardPrice", pt."standardPrice", 0) * ${STOCK_QTY_EXPR}) DESC`,
        ...params,
      )) as Array<{
        row_key: string; row_name: string; col_key?: string; col_name?: string
        line_count: number; qty: number; revenue_ex: number; cost: number; gross_profit: number; costed_amount: number
      }>

      const totalRevenue = rows.reduce((s, r) => s + r.revenue_ex, 0)
      const totalProfit = rows.reduce((s, r) => s + r.gross_profit, 0)
      const totalCosted = rows.reduce((s, r) => s + r.costed_amount, 0)
      const summary = {
        revenueExTax: round2(totalRevenue),
        grossProfit: round2(totalProfit),
        marginPct: totalRevenue > 0 ? round2((totalProfit / totalRevenue) * 100) : 0,
        costCoverageRate: totalRevenue > 0 ? Math.round((totalCosted / totalRevenue) * 10000) / 10000 : 0,
      }

      if (!colDef) {
        return NextResponse.json(serializeApi({
          summary,
          rows: rows.map((r) => ({
            key: r.row_key,
            name: r.row_name,
            lineCount: r.line_count,
            qty: Math.round(r.qty * 1000) / 1000,
            revenueExTax: round2(r.revenue_ex),
            cost: round2(r.cost),
            grossProfit: round2(r.gross_profit),
            marginPct: r.revenue_ex > 0 ? round2((r.gross_profit / r.revenue_ex) * 100) : 0,
            costCoverage: r.revenue_ex > 0 ? Math.round((r.costed_amount / r.revenue_ex) * 10000) / 10000 : 0,
          })),
        }))
      }

      const rawCells: PivotRawCell[] = rows.map((r) => ({
        rowKey: r.row_key,
        rowName: r.row_name,
        colKey: String(r.col_key),
        colName: String(r.col_name),
        qty: r.qty,
        revenueExTax: r.revenue_ex,
        cost: r.cost,
        grossProfit: r.gross_profit,
      }))

      try {
        const pivot = buildPivot(rawCells, { rowIsTimeBucket: rowDef.isTimeBucket, colIsTimeBucket: colDef.isTimeBucket })
        return NextResponse.json(serializeApi({ summary, ...pivot }))
      } catch (err) {
        if (err instanceof PivotTooManyColumnsError) {
          return NextResponse.json({ error: err.message }, { status: 400 })
        }
        throw err
      }
    } catch (error) {
      console.error('[GET /api/analytics/margin]', error)
      return NextResponse.json({ error: '获取毛利分析失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错（原有仓库若已有历史报错，确认数量没有增加即可）

- [ ] **Step 3: 起本地服务，铸造一个测试 JWT 做手工验证**

这个路由靠 Prisma 查真实数据库，仓库里没有 DB mock 的测试基础设施（`tests/*.test.ts` 里唯一碰真实 DB 的 `pricing-override.test.ts` 也是连生产库校验特定客户数据），所以这一步用 curl 手工验证，不写自动化集成测试。

```bash
npm run dev &
sleep 3
cat > .tmp-mint-token.ts <<'EOF'
import { config } from 'dotenv'
config({ path: '.env.local' })
import { signToken } from './lib/auth'
signToken({ userId: 'verify', email: 'verify@local', role: 'BOSS', roles: ['BOSS'], name: 'Verify' }).then(t => console.log(t))
EOF
TOKEN=$(npx tsx .tmp-mint-token.ts | tail -1)
rm .tmp-mint-token.ts
echo "TOKEN=$TOKEN"
```

- [ ] **Step 4: 验证不传 colBy 时行为不变**

```bash
curl -s -w "\n--- HTTP %{http_code} ---\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-07-01&to=2026-07-31&groupBy=customer"
```

Expected: HTTP 200，返回 `{summary:{...}, rows:[{key,name,lineCount,qty,revenueExTax,cost,grossProfit,marginPct,costCoverage}, ...]}`，字段名和之前完全一样（可以对照本任务改动前用 `git show HEAD:app/api/analytics/margin/route.ts` 找一版旧响应做字段名对比）

- [ ] **Step 5: 验证透视模式（客户×月份）**

```bash
curl -s -w "\n--- HTTP %{http_code} ---\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-01-01&to=2026-07-31&groupBy=customer&colBy=month"
```

Expected: HTTP 200，返回 `{summary, rows: [{key,name,subtotal:{...}}], cols: [{key,name,subtotal:{...}}], cells: [{rowKey,colKey,...}], grandTotal:{...}}`；`cols` 的 `key` 形如 `2026-01`…`2026-07` 且按时间正序排列

- [ ] **Step 6: 验证边界情况**

```bash
# 行列维度相同 → 400
curl -s -w " [%{http_code}]\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-07-01&to=2026-07-31&groupBy=customer&colBy=customer"

# 未知维度 → 400
curl -s -w " [%{http_code}]\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-07-01&to=2026-07-31&groupBy=customer&colBy=nonsense"

# 列数过多（日分桶 + 长日期范围触发 60+ 列）→ 400 且 message 提示缩短范围/改用周月
curl -s -w " [%{http_code}]\n" -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-01-01&to=2026-07-31&groupBy=customer&colBy=day"

# categoryId 过滤生效（数值应比不加过滤时小或相等）
curl -s -H "Authorization: Bearer $TOKEN" \
  "http://localhost:3000/api/analytics/margin?from=2026-07-01&to=2026-07-31&groupBy=product&categoryId=<任意一个真实分类id>" | head -c 300
```

Expected: 前两个返回 400 + 对应中文提示；第三个 400 + "列数过多"提示；第四个 200 且行数/合计不大于不加过滤时的结果

- [ ] **Step 7: Commit**

```bash
git add app/api/analytics/margin/route.ts
git commit -m "$(cat <<'EOF'
feat(analytics): support colBy pivot mode + entity filters on margin API

Adds optional colBy (product/category/customer/salesUser/day/week/month)
and categoryId/customerId/salesUserId filters to GET /api/analytics/margin.
Without colBy the response is byte-identical to before. With colBy it
delegates matrix shaping to lib/analytics/pivot.ts's buildPivot().
EOF
)"
```

---

### Task 3: 新增 `PivotView.tsx` 透视模式前端组件

**Files:**
- Create: `app/[locale]/classic/boss/analytics/margin/PivotView.tsx`

**Interfaces:**
- Consumes: `DIMENSION_OPTIONS` from `@/lib/analytics/pivot`；`DateRange` type from `@/components/boss/analytics-shared`；`apiGet` from `@/lib/api`；`eur` from `@/lib/format-money`；`downloadCsv` from `@/lib/csv-export`
- Produces: `export default function PivotView({ range }: { range: DateRange }): JSX.Element`（供 Task 4 的 `page.tsx` 引入）
- 依赖的既有 API：`GET /api/product-categories`（返回 `Array<{id,name,nameZh?}>`）、`GET /api/customers?slim=1`（返回 `Array<{id,name,...}>`）、`GET /api/users?role=SALES`（返回 `Array<{id,name,...}>`）

- [ ] **Step 1: 创建 `app/[locale]/classic/boss/analytics/margin/PivotView.tsx`**

```typescript
'use client'
import { useState, useEffect, useCallback, useMemo } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur } from '@/lib/format-money'
import { downloadCsv } from '@/lib/csv-export'
import { DIMENSION_OPTIONS } from '@/lib/analytics/pivot'
import type { DateRange } from '@/components/boss/analytics-shared'

type Measure = 'revenueExTax' | 'grossProfit' | 'marginPct' | 'qty'

interface PivotMeasures {
  revenueExTax: number
  cost: number
  grossProfit: number
  marginPct: number
  qty: number
}

interface PivotHeader { key: string; name: string; subtotal: PivotMeasures }
interface PivotCell extends PivotMeasures { rowKey: string; colKey: string }

interface PivotPayload {
  summary: { revenueExTax: number; grossProfit: number; marginPct: number; costCoverageRate: number }
  rows: PivotHeader[]
  cols: PivotHeader[]
  cells: PivotCell[]
  grandTotal: PivotMeasures
}

interface LookupItem { id: string; name: string }

const MEASURE_TABS: Array<{ key: Measure; label: string }> = [
  { key: 'revenueExTax', label: '销售额' },
  { key: 'grossProfit', label: '毛利' },
  { key: 'marginPct', label: '毛利率' },
  { key: 'qty', label: '数量' },
]

function formatMeasure(measure: Measure, value: number): string {
  if (measure === 'marginPct') return `${value.toFixed(1)}%`
  if (measure === 'qty') return value.toLocaleString('en-IE', { maximumFractionDigits: 3 })
  return eur(value)
}

function csvMeasure(measure: Measure, value: number): string {
  if (measure === 'marginPct') return value.toFixed(1)
  if (measure === 'qty') return String(value)
  return value.toFixed(2)
}

export default function PivotView({ range }: { range: DateRange }) {
  const [rowBy, setRowBy] = useState('customer')
  const [colBy, setColBy] = useState('month')
  const [measure, setMeasure] = useState<Measure>('revenueExTax')
  const [categoryId, setCategoryId] = useState('')
  const [customerId, setCustomerId] = useState('')
  const [salesUserId, setSalesUserId] = useState('')
  const [categories, setCategories] = useState<LookupItem[]>([])
  const [customers, setCustomers] = useState<LookupItem[]>([])
  const [salesUsers, setSalesUsers] = useState<LookupItem[]>([])
  const [data, setData] = useState<PivotPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  useEffect(() => {
    apiGet<Array<{ id: string; name: string; nameZh?: string | null }>>('/api/product-categories')
      .then((rows) => setCategories(rows.map((c) => ({ id: c.id, name: c.nameZh || c.name }))))
      .catch((e) => toast.error(e.message))
    apiGet<Array<{ id: string; name: string }>>('/api/customers?slim=1')
      .then((rows) => setCustomers(rows.map((c) => ({ id: c.id, name: c.name }))))
      .catch((e) => toast.error(e.message))
    apiGet<Array<{ id: string; name: string }>>('/api/users?role=SALES')
      .then((rows) => setSalesUsers(rows.map((u) => ({ id: u.id, name: u.name }))))
      .catch((e) => toast.error(e.message))
  }, [])

  const load = useCallback(() => {
    setData(null)
    setError(null)
    const params = new URLSearchParams({ from: range.from, to: range.to, groupBy: rowBy, colBy })
    if (categoryId) params.set('categoryId', categoryId)
    if (customerId) params.set('customerId', customerId)
    if (salesUserId) params.set('salesUserId', salesUserId)
    apiGet<PivotPayload>(`/api/analytics/margin?${params.toString()}`)
      .then(setData)
      .catch((e) => setError(e.message))
  }, [range, rowBy, colBy, categoryId, customerId, salesUserId])
  useEffect(() => { load() }, [load])

  const cellMap = useMemo(() => {
    const m = new Map<string, PivotCell>()
    data?.cells.forEach((c) => m.set(`${c.rowKey}|${c.colKey}`, c))
    return m
  }, [data])

  const filteredRows = (data?.rows ?? []).filter((r) =>
    search.trim() === '' || r.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  function handleRowByChange(next: string) {
    const prevRowBy = rowBy
    setRowBy(next)
    if (next === colBy) setColBy(prevRowBy)
  }
  function handleColByChange(next: string) {
    const prevColBy = colBy
    setColBy(next)
    if (next === rowBy) setRowBy(prevColBy)
  }

  function exportCsv() {
    if (!data) return
    const rowLabel = DIMENSION_OPTIONS.find((o) => o.key === rowBy)?.label ?? '行'
    const headers = [rowLabel, ...data.cols.map((c) => c.name), '小计']
    const rows = data.rows.map((r) => [
      r.name,
      ...data.cols.map((c) => {
        const cell = cellMap.get(`${r.key}|${c.key}`)
        return cell ? csvMeasure(measure, cell[measure]) : ''
      }),
      csvMeasure(measure, r.subtotal[measure]),
    ])
    rows.push([
      '总计',
      ...data.cols.map((c) => csvMeasure(measure, c.subtotal[measure])),
      csvMeasure(measure, data.grandTotal[measure]),
    ])
    downloadCsv(`margin-pivot-${range.from}_${range.to}`, headers, rows)
  }

  const coverage = (data?.summary.costCoverageRate ?? 0) * 100

  return (
    <div className="space-y-3">
      {data && coverage < 70 && (
        <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-2.5">
          ⚠ 实际批次成本覆盖率仅 {coverage.toFixed(0)}%，其余按标准成本（收货加权平均）估算。
        </div>
      )}

      <div className="flex flex-wrap items-center gap-2 text-sm">
        <label className="text-gray-500">行</label>
        <select className="border rounded px-2 py-1" value={rowBy} onChange={(e) => handleRowByChange(e.target.value)}>
          {DIMENSION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <label className="text-gray-500">列</label>
        <select className="border rounded px-2 py-1" value={colBy} onChange={(e) => handleColByChange(e.target.value)}>
          {DIMENSION_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
        </select>
        <label className="text-gray-500 ml-2">度量</label>
        <div className="flex border rounded overflow-hidden">
          {MEASURE_TABS.map((t) => (
            <button
              key={t.key}
              onClick={() => setMeasure(t.key)}
              className={`px-3 py-1 ${measure === t.key ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
            >
              {t.label}
            </button>
          ))}
        </div>
        <select className="border rounded px-2 py-1 ml-2" value={categoryId} onChange={(e) => setCategoryId(e.target.value)}>
          <option value="">全部分类</option>
          {categories.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={customerId} onChange={(e) => setCustomerId(e.target.value)}>
          <option value="">全部客户</option>
          {customers.map((c) => <option key={c.id} value={c.id}>{c.name}</option>)}
        </select>
        <select className="border rounded px-2 py-1" value={salesUserId} onChange={(e) => setSalesUserId(e.target.value)}>
          <option value="">全部业务员</option>
          {salesUsers.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </select>
        <input
          className="border rounded px-3 py-1 w-48 ml-2"
          placeholder="搜索行名…"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
        />
        <button
          className="border rounded px-3 py-1 text-white ml-auto disabled:opacity-40"
          style={{ backgroundColor: '#875A7B' }}
          disabled={!data}
          onClick={exportCsv}
        >
          导出 CSV
        </button>
      </div>

      {error && (
        <div className="bg-red-50 border border-red-200 text-red-700 text-sm rounded px-4 py-2.5">{error}</div>
      )}

      {!data && !error ? (
        <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
      ) : data ? (
        <div className="border rounded overflow-auto max-h-[70vh]">
          <table className="text-sm border-collapse">
            <thead className="bg-gray-50 sticky top-0 z-10">
              <tr>
                <th className="px-3 py-2 text-left font-medium sticky left-0 bg-gray-50 z-20 border-r whitespace-nowrap">
                  {DIMENSION_OPTIONS.find((o) => o.key === rowBy)?.label} \ {DIMENSION_OPTIONS.find((o) => o.key === colBy)?.label}
                </th>
                {data.cols.map((c) => (
                  <th key={c.key} className="px-3 py-2 text-right font-medium whitespace-nowrap">{c.name}</th>
                ))}
                <th className="px-3 py-2 text-right font-medium whitespace-nowrap border-l">小计</th>
              </tr>
            </thead>
            <tbody>
              {filteredRows.map((r) => (
                <tr key={r.key} className="border-t hover:bg-gray-50">
                  <td className="px-3 py-1.5 sticky left-0 bg-white z-10 border-r font-medium whitespace-nowrap">{r.name}</td>
                  {data.cols.map((c) => {
                    const cell = cellMap.get(`${r.key}|${c.key}`)
                    const negative = cell && (measure === 'grossProfit' || measure === 'marginPct') && cell[measure] < 0
                    return (
                      <td key={c.key} className={`px-3 py-1.5 text-right tabular-nums whitespace-nowrap ${negative ? 'text-red-600' : ''}`}>
                        {cell ? formatMeasure(measure, cell[measure]) : '—'}
                      </td>
                    )
                  })}
                  <td className="px-3 py-1.5 text-right tabular-nums whitespace-nowrap border-l font-medium">
                    {formatMeasure(measure, r.subtotal[measure])}
                  </td>
                </tr>
              ))}
              {filteredRows.length === 0 && (
                <tr><td colSpan={data.cols.length + 2} className="px-3 py-8 text-center text-gray-400">没有匹配的数据</td></tr>
              )}
            </tbody>
            {filteredRows.length > 0 && (
              <tfoot className="bg-gray-50 border-t-2">
                <tr>
                  <td className="px-3 py-1.5 sticky left-0 bg-gray-50 border-r font-medium whitespace-nowrap">总计</td>
                  {data.cols.map((c) => (
                    <td key={c.key} className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap">
                      {formatMeasure(measure, c.subtotal[measure])}
                    </td>
                  ))}
                  <td className="px-3 py-1.5 text-right tabular-nums font-medium whitespace-nowrap border-l">
                    {formatMeasure(measure, data.grandTotal[measure])}
                  </td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      ) : null}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错

- [ ] **Step 3: Commit**

```bash
git add "app/[locale]/classic/boss/analytics/margin/PivotView.tsx"
git commit -m "$(cat <<'EOF'
feat(analytics): add PivotView component for margin pivot mode

Row/column dimension pickers (incl. day/week/month time buckets),
measure switcher, category/customer/salesUser filters, sticky-header
matrix table, and CSV export. Self-contained — page.tsx only needs to
render it behind a mode toggle (next task).
EOF
)"
```

---

### Task 4: `page.tsx` 接入模式切换

**Files:**
- Modify: `app/[locale]/classic/boss/analytics/margin/page.tsx`（整体重写，见下方完整内容）

**Interfaces:**
- Consumes: `PivotView` from `./PivotView`（Task 3 产出）

- [ ] **Step 1: 用整体重写替换 `app/[locale]/classic/boss/analytics/margin/page.tsx`**

```typescript
'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import PivotView from './PivotView'

type GroupBy = 'product' | 'category' | 'customer' | 'salesUser'
type Mode = 'single' | 'pivot'

interface Row {
  key: string; name: string; lineCount: number; qty: number
  revenueExTax: number; cost: number; grossProfit: number
  marginPct: number; costCoverage: number
}

interface Payload {
  summary: { revenueExTax: number; grossProfit: number; marginPct: number; costCoverageRate: number }
  rows: Row[]
}

const GROUP_TABS: Array<{ key: GroupBy; label: string }> = [
  { key: 'product', label: '按商品' },
  { key: 'category', label: '按分类' },
  { key: 'customer', label: '按客户' },
  { key: 'salesUser', label: '按业务员' },
]

export default function MarginAnalyticsPage() {
  const [range, setRange] = useState<DateRange>(defaultRange())
  const [mode, setMode] = useState<Mode>('single')
  const [groupBy, setGroupBy] = useState<GroupBy>('product')
  const [data, setData] = useState<Payload | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback((r: DateRange, g: GroupBy) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/margin?from=${r.from}&to=${r.to}&groupBy=${g}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { if (mode === 'single') load(range, groupBy) }, [load, mode]) // eslint-disable-line react-hooks/exhaustive-deps

  const coverage = (data?.summary.costCoverageRate ?? 0) * 100
  const filtered = (data?.rows ?? []).filter((r) =>
    search.trim() === '' || r.name.toLowerCase().includes(search.trim().toLowerCase()),
  )

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-2xl font-bold text-gray-900">毛利分析</h1>
        <div className="flex items-center gap-3">
          <div className="flex border rounded overflow-hidden text-sm">
            {(['single', 'pivot'] as const).map((m) => (
              <button
                key={m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 ${mode === m ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
              >
                {m === 'single' ? '单维度' : '透视模式'}
              </button>
            ))}
          </div>
          <DateRangeBar value={range} onChange={(r) => { setRange(r); if (mode === 'single') load(r, groupBy) }} />
        </div>
      </div>

      {mode === 'pivot' ? (
        <PivotView range={range} />
      ) : (
        <>
          {data && coverage < 70 && (
            <div className="bg-amber-50 border border-amber-200 text-amber-800 text-sm rounded px-4 py-2.5">
              ⚠ 实际批次成本覆盖率仅 {coverage.toFixed(0)}%，其余按标准成本（收货加权平均）估算。
              批次成本随收货流程自动积累，覆盖率会逐步上升。
            </div>
          )}

          {!data ? (
            <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>
          ) : (
            <>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">销售额（税前）</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(data.summary.revenueExTax)}</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">毛利</div>
                  <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.summary.grossProfit < 0 ? 'text-red-600' : 'text-green-700'}`}>
                    {eur(data.summary.grossProfit)}</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">毛利率</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{data.summary.marginPct.toFixed(1)}%</div></div>
                <div className="border rounded-lg p-4"><div className="text-xs text-gray-500">实际成本覆盖率</div>
                  <div className="text-2xl font-semibold mt-1 tabular-nums">{coverage.toFixed(0)}%</div>
                  <div className="text-xs text-gray-400 mt-1">其余按标准成本估算</div></div>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <div className="flex border rounded overflow-hidden">
                  {GROUP_TABS.map((t) => (
                    <button
                      key={t.key}
                      onClick={() => { setGroupBy(t.key); load(range, t.key) }}
                      className={`px-4 py-1.5 text-sm ${groupBy === t.key ? 'bg-[#875A7B] text-white' : 'text-gray-600 hover:bg-gray-50'}`}
                    >
                      {t.label}
                    </button>
                  ))}
                </div>
                <input
                  className="border rounded px-3 py-1.5 text-sm w-64"
                  placeholder="搜索…"
                  value={search}
                  onChange={(e) => setSearch(e.target.value)}
                />
                <span className="text-xs text-gray-400">{filtered.length} 行，按毛利降序</span>
              </div>

              <div className="border rounded overflow-hidden">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-left">
                    <tr>
                      <th className="px-3 py-2 font-medium">{GROUP_TABS.find(t => t.key === groupBy)?.label.slice(1)}</th>
                      <th className="px-3 py-2 font-medium text-right">数量</th>
                      <th className="px-3 py-2 font-medium text-right">销售额（税前）</th>
                      <th className="px-3 py-2 font-medium text-right">成本</th>
                      <th className="px-3 py-2 font-medium text-right">毛利</th>
                      <th className="px-3 py-2 font-medium text-right">毛利率</th>
                      <th className="px-3 py-2 font-medium text-right">成本口径</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((r) => (
                      <tr key={r.key} className="border-t hover:bg-gray-50">
                        <td className="px-3 py-1.5">{r.name}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{r.qty}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums">{eur(r.revenueExTax)}</td>
                        <td className="px-3 py-1.5 text-right tabular-nums text-gray-500">{eur(r.cost)}</td>
                        <td className={`px-3 py-1.5 text-right tabular-nums font-medium ${r.grossProfit < 0 ? 'text-red-600' : ''}`}>
                          {eur(r.grossProfit)}
                        </td>
                        <td className={`px-3 py-1.5 text-right tabular-nums ${r.marginPct < 0 ? 'text-red-600' : r.marginPct < 10 ? 'text-amber-600' : ''}`}>
                          {r.marginPct.toFixed(1)}%
                        </td>
                        <td className="px-3 py-1.5 text-right">
                          <span className={`text-xs px-1.5 py-0.5 rounded ${r.costCoverage >= 0.999 ? 'bg-green-100 text-green-700' : r.costCoverage > 0 ? 'bg-amber-100 text-amber-700' : 'bg-gray-100 text-gray-500'}`}>
                            {r.costCoverage >= 0.999 ? '批次' : r.costCoverage > 0 ? `批次 ${(r.costCoverage * 100).toFixed(0)}%` : '标准'}
                          </span>
                        </td>
                      </tr>
                    ))}
                    {filtered.length === 0 && (
                      <tr><td colSpan={7} className="px-3 py-8 text-center text-gray-400">期内没有数据</td></tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </>
      )}
    </div>
  )
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无新增报错

- [ ] **Step 3: 浏览器手工验证（对照项目"完成标准"，不能只看编译通过）**

```bash
npm run dev
```

打开 `http://localhost:3000/boss/analytics/margin`（用 BOSS 账号登录），依次确认：
1. 页面默认是「单维度」模式，展示和改造前完全一样的四个 tab + 表格
2. 点「透视模式」→ 出现行/列维度下拉（默认 客户×月）、度量按钮、三个筛选下拉、导出 CSV 按钮，表格渲染出矩阵，含小计列/行和右下角总计
3. 把「列」切成「客户」（和「行」相同）→ 自动把原来的「行」维度换到「列」上（互换，不是报错）
4. 切换度量按钮（销售额/毛利/毛利率/数量）→ 表格数值跟着变，行列顺序不跳动
5. 选一个「商品分类」筛选 → 数据变小/变化，取消筛选恢复
6. 把日期范围拉长到覆盖 90+ 天、列维度选「日」→ 页面展示红色"列数过多"提示，不崩溃、不渲染残缺表格
7. 点击「导出 CSV」→ 浏览器下载一个 CSV 文件，用文本编辑器或 Excel 打开确认表头/数据/总计行都对得上屏幕上的矩阵
8. 切回「单维度」→ 恢复到原来的表格和统计卡片，数据没有丢

- [ ] **Step 4: Commit**

```bash
git add "app/[locale]/classic/boss/analytics/margin/page.tsx"
git commit -m "$(cat <<'EOF'
feat(analytics): wire pivot mode toggle into margin analysis page

Adds a 单维度/透视模式 switch; single-dim view is untouched behavior,
pivot mode renders the new PivotView component.
EOF
)"
```

---

## Self-Review Notes

- **Spec coverage**：设计文档三部分（API/前端/边界）分别对应 Task 2、Task 3+4、Task 1 的列数上限测试 + Task 2 的 400 校验 —— 全部有落地任务。
- **Placeholder scan**：无 TBD/"类似 Task N"/未展开的步骤；每个 Step 都是可直接执行的完整代码或命令。
- **Type consistency**：`PivotRawCell`/`PivotHeader`/`PivotCell`/`PivotMeasures`/`PivotResult`/`DIMENSION_DEFS`/`DIMENSION_OPTIONS`/`PivotTooManyColumnsError`/`buildPivot` 在 Task 1 定义，Task 2（route.ts）与 Task 3（PivotView.tsx）里的字段名/函数签名逐一核对一致（`rowKey/colKey/rowName/colName`、`subtotal`、`grandTotal`、`cells`）。
- **行列互换**是本轮在写 PivotView 时相对设计文档补的一个小交互细节（设计文档只说"互斥彼此已选值"，没规定选中相同维度时具体怎么处理）——采用"互换"而不是"报错"或"随便挑一个"，体验最顺；已在 Task 4 验证步骤里加了对应的手工检查项。
