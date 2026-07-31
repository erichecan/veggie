# 销售统计四项指标统一视图 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增一个"数据分析中心"页面 `boss/analytics/sales-overview`，把日销售额/客单价/缺货率做成可按日期范围查看的趋势图 + 关键商品 Top10 排行；同时给调度日销页面 `SalesStats.tsx` 新增客单价/缺货率两张只读汇总卡片。两条改动线互不影响，不下线任何现有入口。

**Architecture:** 新增一个组合 API 路由 `/api/analytics/sales-overview`，直接复用已有的 `dailyBusinessSnapshot` 快照表（日销售额/客单价的数据源，`ensureSnapshots()` 保证数据齐全）和从 `/api/analytics/shortage` 抽出的共享缺货率计算函数（避免两处各写一份公式），只新增一个"关键商品 Top10"的聚合查询。前端新页面用现成的 `DateRangeBar` 组件按日期范围查询；`SalesStats.tsx` 的两张新卡片直接调用同一个新 API，保证和分析中心数字口径完全一致。

**Tech Stack:** Next.js App Router、TypeScript、Prisma（原生 `$queryRawUnsafe` 做聚合）、recharts、node:test（`node --test --import=tsx tests/*.test.ts`）

## Global Constraints

- 所有分析类常量/口径必须来自 `lib/analytics/metrics.ts`，禁止在路由里自建状态集合/日期口径（见该文件顶部注释）
- 销售口径统一用 `Order.confirmationDate`；物流/缺货口径统一用 `Order.deliveryDate`（对应 `docs/20260703-analytics-metric-definitions.md`）
- 所有 `/api/analytics/*` 路由必须用 `withAuth(req, handler, roles)` 鉴权，`SALES_COUNTED_STATUSES` 之外的订单状态不计入销售额/客单价
- API 响应统一用 `serializeApi()` 包一层（Prisma Decimal → number，Date → ISO string）
- 不改动本次范围外的任何现有入口/页面展示逻辑（`boss/page.tsx` 首页 KPI、`customers` 页面客单价列保持原样）

---

### Task 1: 抽取纯函数 `deriveAov`（客单价派生公式）

**Files:**
- Modify: `lib/analytics/metrics.ts`（在文件末尾追加）
- Test: `tests/analytics-metrics-aov.test.ts`（新建）

**Interfaces:**
- Produces: `deriveAov(salesExTax: number, orderCount: number): number` — 后续 Task 3（新路由）、Task 5（SalesStats 卡片，前端直接算不导入这个但公式必须一致）都用同一份四舍五入规则

- [ ] **Step 1: 写失败的单测**

创建 `tests/analytics-metrics-aov.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { deriveAov } from '../lib/analytics/metrics'

test('订单数为 0 → 客单价 0，不除以零', () => {
  assert.equal(deriveAov(1234.5, 0), 0)
})

test('正常计算并四舍五入到分', () => {
  assert.equal(deriveAov(100, 3), 33.33)
})

test('整除的情况保留两位小数语义（数值相等即可）', () => {
  assert.equal(deriveAov(200, 2), 100)
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/analytics-metrics-aov.test.ts`
Expected: FAIL，报 `deriveAov is not a function` 或找不到导出

- [ ] **Step 3: 实现 `deriveAov`**

在 `lib/analytics/metrics.ts` 文件末尾（`toDayKey` 函数之后）追加：

```typescript
/** 客单价 = 销售额（税前） / 订单数，订单数为 0 时记 0，避免除零。四舍五入到分。 */
export function deriveAov(salesExTax: number, orderCount: number): number {
  return orderCount > 0 ? Math.round((salesExTax / orderCount) * 100) / 100 : 0
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/analytics-metrics-aov.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 提交**

```bash
git add lib/analytics/metrics.ts tests/analytics-metrics-aov.test.ts
git commit -m "feat(analytics): add deriveAov shared helper"
```

---

### Task 2: 抽取共享缺货率计算，重构 `/api/analytics/shortage` 复用它

**Files:**
- Create: `lib/analytics/shortage.ts`
- Modify: `app/api/analytics/shortage/route.ts`
- Test: `tests/analytics-shortage-summary.test.ts`（新建）

**Interfaces:**
- Consumes: `SALES_COUNTED_STATUSES` from `lib/analytics/metrics.ts`（已存在）
- Produces:
  - `computeShortageDaily(start: Date, end: Date): Promise<ShortageDailyRow[]>`（`ShortageDailyRow = { day: Date; shortage_lines: number; order_lines: number }`）
  - `summarizeShortageDaily(daily: ShortageDailyRow[]): ShortageSummary`（`ShortageSummary = { shortageLines: number; orderLines: number; shortageRate: number }`）
  - 两者供 Task 3 的新路由 `/api/analytics/sales-overview` 使用

- [ ] **Step 1: 写失败的单测（只测纯函数 `summarizeShortageDaily`，不测查库的 `computeShortageDaily`）**

创建 `tests/analytics-shortage-summary.test.ts`：

```typescript
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeShortageDaily } from '../lib/analytics/shortage'

test('空数组 → 全 0，缺货率不除零', () => {
  assert.deepEqual(summarizeShortageDaily([]), { shortageLines: 0, orderLines: 0, shortageRate: 0 })
})

test('按天累加缺货行/订单行，算出缺货率并四舍五入到万分位', () => {
  const daily = [
    { day: new Date('2026-07-01'), shortage_lines: 2, order_lines: 20 },
    { day: new Date('2026-07-02'), shortage_lines: 1, order_lines: 30 },
  ]
  assert.deepEqual(summarizeShortageDaily(daily), { shortageLines: 3, orderLines: 50, shortageRate: 0.06 })
})

test('订单行数为 0 → 缺货率记 0（不是 NaN）', () => {
  const daily = [{ day: new Date('2026-07-01'), shortage_lines: 0, order_lines: 0 }]
  assert.deepEqual(summarizeShortageDaily(daily), { shortageLines: 0, orderLines: 0, shortageRate: 0 })
})
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx tsx --test tests/analytics-shortage-summary.test.ts`
Expected: FAIL，模块 `../lib/analytics/shortage` 不存在

- [ ] **Step 3: 创建 `lib/analytics/shortage.ts`**

把原 `app/api/analytics/shortage/route.ts` 里"按天缺货行/订单行"的查询（原文件第 27-54 行）和汇总数学（原文件第 86-93 行）原样搬过来，不改变任何 SQL 或公式：

```typescript
/**
 * 缺货率计算 · 共享实现
 * ============================================================================
 * 被 /api/analytics/shortage 和 /api/analytics/sales-overview 两个路由共用，
 * 避免各自维护一份公式后续跑偏。口径：物流口径（deliveryDate），
 * 缺货行 = OrderDiscrepancy 非 CANCELLED 行数，订单行 = SALES_COUNTED_STATUSES 内订单行数。
 */
import { prisma } from '@/lib/db'
import { SALES_COUNTED_STATUSES } from '@/lib/analytics/metrics'

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export interface ShortageDailyRow {
  day: Date
  shortage_lines: number
  order_lines: number
}

export interface ShortageSummary {
  shortageLines: number
  orderLines: number
  shortageRate: number
}

/** 按天缺货行数 / 订单行数，[start, end) 半开区间。 */
export async function computeShortageDaily(start: Date, end: Date): Promise<ShortageDailyRow[]> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const p = prisma as any
  return (await p.$queryRawUnsafe(
    `WITH days AS (
       SELECT generate_series($1::date, ($2::date - INTERVAL '1 day')::date, '1 day')::date AS d
     ),
     short AS (
       SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
       FROM "OrderDiscrepancy" dc
       JOIN "Order" o ON o.id = dc."orderId"
       WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2 AND dc.status <> 'CANCELLED'
       GROUP BY o."deliveryDate"::date
     ),
     lines AS (
       SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
       FROM "OrderLine" ol
       JOIN "Order" o ON o.id = ol."orderId"
       WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
         AND o.status::text IN (${SALES_STATUS_SQL})
       GROUP BY o."deliveryDate"::date
     )
     SELECT days.d AS day,
            COALESCE(short.cnt, 0) AS shortage_lines,
            COALESCE(lines.cnt, 0) AS order_lines
     FROM days
     LEFT JOIN short ON short.d = days.d
     LEFT JOIN lines ON lines.d = days.d
     ORDER BY days.d`,
    start, end,
  )) as ShortageDailyRow[]
}

/** 纯函数：把按天序列汇总成缺货率。不查库，可单测。 */
export function summarizeShortageDaily(daily: ShortageDailyRow[]): ShortageSummary {
  const shortageLines = daily.reduce((s, d) => s + d.shortage_lines, 0)
  const orderLines = daily.reduce((s, d) => s + d.order_lines, 0)
  return {
    shortageLines,
    orderLines,
    shortageRate: orderLines > 0 ? Math.round((shortageLines / orderLines) * 10000) / 10000 : 0,
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx tsx --test tests/analytics-shortage-summary.test.ts`
Expected: PASS，3 个用例全绿

- [ ] **Step 5: 重构 `app/api/analytics/shortage/route.ts` 改用共享函数（不改变响应格式）**

把文件顶部的：

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange } from '@/lib/analytics/metrics'

/**
 * /api/analytics/shortage — 缺货分析 × 采购联动
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   daily      每日缺货行数 / 订单行数（物流口径 deliveryDate）
 *   byProduct  按商品：缺货次数、缺货量、影响订单数、当前库存、
 *              采购联动状态（是否有 pending/ordered 的采购建议、是否有在途 PO）
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')
```

替换为：

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { computeShortageDaily, summarizeShortageDaily } from '@/lib/analytics/shortage'

/**
 * /api/analytics/shortage — 缺货分析 × 采购联动
 * ============================================================================
 * GET ?from&to
 * 返回：
 *   daily      每日缺货行数 / 订单行数（物流口径 deliveryDate）—— 计算逻辑见 lib/analytics/shortage.ts
 *   byProduct  按商品：缺货次数、缺货量、影响订单数、当前库存、
 *              采购联动状态（是否有 pending/ordered 的采购建议、是否有在途 PO）
 */
```

（`SALES_STATUS_SQL` 常量删除——重构后这个文件里只有 `byProduct` 查询用到原始 SQL，它本来就不引用 `SALES_STATUS_SQL`，删除前先确认：`grep -n "SALES_STATUS_SQL" app/api/analytics/shortage/route.ts` 重构后应该只在被删的那一行出现。）

把原来第 27-54 行的 `daily` 查询整块：

```typescript
      const daily = (await p.$queryRawUnsafe(
        `WITH days AS (
           SELECT generate_series($1::date, ($2::date - INTERVAL '1 day')::date, '1 day')::date AS d
         ),
         short AS (
           SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
           FROM "OrderDiscrepancy" dc
           JOIN "Order" o ON o.id = dc."orderId"
           WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2 AND dc.status <> 'CANCELLED'
           GROUP BY o."deliveryDate"::date
         ),
         lines AS (
           SELECT o."deliveryDate"::date AS d, COUNT(*)::int AS cnt
           FROM "OrderLine" ol
           JOIN "Order" o ON o.id = ol."orderId"
           WHERE o."deliveryDate" >= $1 AND o."deliveryDate" < $2
             AND o.status::text IN (${SALES_STATUS_SQL})
           GROUP BY o."deliveryDate"::date
         )
         SELECT days.d AS day,
                COALESCE(short.cnt, 0) AS shortage_lines,
                COALESCE(lines.cnt, 0) AS order_lines
         FROM days
         LEFT JOIN short ON short.d = days.d
         LEFT JOIN lines ON lines.d = days.d
         ORDER BY days.d`,
        start, end,
      )) as Array<{ day: Date; shortage_lines: number; order_lines: number }>
```

替换为：

```typescript
      const daily = await computeShortageDaily(start, end)
```

把原来第 86-97 行的：

```typescript
      const totalShort = daily.reduce((s, d) => s + d.shortage_lines, 0)
      const totalLines = daily.reduce((s, d) => s + d.order_lines, 0)

      return NextResponse.json(serializeApi({
        summary: {
          shortageLines: totalShort,
          orderLines: totalLines,
          shortageRate: totalLines > 0 ? Math.round((totalShort / totalLines) * 10000) / 10000 : 0,
          productsAffected: byProduct.length,
          // 缺货但既无采购建议也无在途 PO 的商品数（真正的采购盲区）
          unlinked: byProduct.filter((r) => !r.has_suggestion && !r.has_incoming_po).length,
        },
        daily,
        byProduct,
      }))
```

替换为：

```typescript
      const shortageSummary = summarizeShortageDaily(daily)

      return NextResponse.json(serializeApi({
        summary: {
          ...shortageSummary,
          productsAffected: byProduct.length,
          // 缺货但既无采购建议也无在途 PO 的商品数（真正的采购盲区）
          unlinked: byProduct.filter((r) => !r.has_suggestion && !r.has_incoming_po).length,
        },
        daily,
        byProduct,
      }))
```

响应 JSON 结构和字段值必须与重构前完全一致（这是纯提取，不是改逻辑）。

- [ ] **Step 6: 类型检查 + 启动本地服务，curl 回归验证响应不变**

Run: `npx tsc --noEmit`
Expected: 无新增类型错误

Run（先起 `npm run dev`，另开终端）:
```bash
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"identifier":"<已知测试账号>","password":"<已知密码>"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/analytics/shortage?from=2026-07-01&to=2026-07-30" | head -c 500
```
Expected: HTTP 200，返回 JSON 含 `summary.shortageRate`、`daily`、`byProduct`，字段结构与重构前一致（无 500、无字段缺失）

- [ ] **Step 7: 提交**

```bash
git add lib/analytics/shortage.ts app/api/analytics/shortage/route.ts tests/analytics-shortage-summary.test.ts
git commit -m "refactor(analytics): extract shared shortage-rate calculation"
```

---

### Task 3: 新增组合 API 路由 `/api/analytics/sales-overview`

**Files:**
- Create: `app/api/analytics/sales-overview/route.ts`

**Interfaces:**
- Consumes:
  - `resolveDateRange`, `SALES_COUNTED_STATUSES`, `deriveAov` from `@/lib/analytics/metrics`（Task 1 产出 `deriveAov`）
  - `ensureSnapshots` from `@/lib/analytics/snapshot`
  - `computeShortageDaily`, `summarizeShortageDaily` from `@/lib/analytics/shortage`（Task 2 产出）
  - `withAuth` from `@/lib/auth`，`serializeApi` from `@/lib/api-serializer`
- Produces: `GET /api/analytics/sales-overview?from&to` 返回
  ```typescript
  {
    dailySeries: Array<{ date: string; salesExTax: number; salesIncTax: number; orderCount: number; aov: number }>
    shortage: { series: Array<{ day: string; shortage_lines: number; order_lines: number }>; summary: { shortageLines: number; orderLines: number; shortageRate: number } }
    topProducts: Array<{ productId: string; productName: string; subtotal: number; qty: number }>
  }
  ```
  供 Task 4（新页面）和 Task 5（SalesStats 卡片）消费

- [ ] **Step 1: 创建路由文件**

创建 `app/api/analytics/sales-overview/route.ts`：

```typescript
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { SALES_COUNTED_STATUSES, resolveDateRange, deriveAov } from '@/lib/analytics/metrics'
import { ensureSnapshots } from '@/lib/analytics/snapshot'
import { computeShortageDaily, summarizeShortageDaily } from '@/lib/analytics/shortage'

/**
 * /api/analytics/sales-overview — 销售统计统一视图
 * ============================================================================
 * GET ?from&to
 * 一次请求返回四项指标（日销售额/客单价/缺货率的按天序列 + 关键商品 Top10）：
 *   dailySeries  日销售额 + 客单价（销售口径 confirmationDate，读 dailyBusinessSnapshot 快照表，
 *                口径与 boss/page.tsx 首页趋势图、/api/analytics/snapshots 完全一致）
 *   shortage     缺货率按天序列 + 汇总（物流口径 deliveryDate，与 /api/analytics/shortage 共用
 *                lib/analytics/shortage.ts 里的同一份计算，避免两处公式跑偏）
 *   topProducts  所选范围内按销售额（subtotal）汇总取 Top 10，每次按范围重新排名
 */

const SALES_STATUS_SQL = SALES_COUNTED_STATUSES.map((s) => `'${s}'`).join(', ')

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const { start, end } = resolveDateRange(searchParams.get('from'), searchParams.get('to'))
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      await ensureSnapshots()
      const snapshots = (await p.dailyBusinessSnapshot.findMany({
        where: { snapshotDate: { gte: start, lt: end } },
        orderBy: { snapshotDate: 'asc' },
        select: { snapshotDate: true, salesExTax: true, salesIncTax: true, orderCount: true },
      })) as Array<{ snapshotDate: Date; salesExTax: unknown; salesIncTax: unknown; orderCount: number }>

      const dailySeries = snapshots.map((s) => {
        const salesExTax = Number(s.salesExTax)
        const salesIncTax = Number(s.salesIncTax)
        return {
          date: s.snapshotDate,
          salesExTax,
          salesIncTax,
          orderCount: s.orderCount,
          aov: deriveAov(salesExTax, s.orderCount),
        }
      })

      const shortageDaily = await computeShortageDaily(start, end)
      const shortageSummary = summarizeShortageDaily(shortageDaily)

      const topProductsRows = (await p.$queryRawUnsafe(
        `SELECT ol."productId" AS product_id,
                MAX(ol."productName") AS product_name,
                SUM(ol.subtotal)::float AS subtotal,
                SUM(ol."orderedQty")::float AS qty
         FROM "OrderLine" ol
         JOIN "Order" o ON o.id = ol."orderId"
         WHERE o.status::text IN (${SALES_STATUS_SQL})
           AND o."confirmationDate" >= $1 AND o."confirmationDate" < $2
         GROUP BY ol."productId"
         ORDER BY SUM(ol.subtotal) DESC
         LIMIT 10`,
        start, end,
      )) as Array<{ product_id: string; product_name: string; subtotal: number; qty: number }>

      const topProducts = topProductsRows.map((r) => ({
        productId: r.product_id,
        productName: r.product_name,
        subtotal: Math.round(r.subtotal * 100) / 100,
        qty: r.qty,
      }))

      return NextResponse.json(serializeApi({
        dailySeries,
        shortage: { series: shortageDaily, summary: shortageSummary },
        topProducts,
      }))
    } catch (error) {
      console.error('[GET /api/analytics/sales-overview]', error)
      return NextResponse.json({ error: '获取销售统计总览失败' }, { status: 500 })
    }
  }, ['BOSS', 'OPERATOR', 'FINANCE'])
}
```

- [ ] **Step 2: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 3: 启动本地服务，curl 验证鉴权 + 正常响应**

```bash
# 未带 token → 401
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/api/analytics/sales-overview?from=2026-07-01&to=2026-07-30"
# Expected: 401

# 带 token → 200，三个字段都在
TOKEN=$(curl -s -X POST http://localhost:3000/api/auth/login -H "Content-Type: application/json" -d '{"identifier":"<已知测试账号>","password":"<已知密码>"}' | grep -o '"token":"[^"]*"' | cut -d'"' -f4)
curl -s -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/analytics/sales-overview?from=2026-07-01&to=2026-07-30" | python3 -m json.tool | head -40
# Expected: 200，JSON 含 dailySeries[]（每项有 date/salesExTax/salesIncTax/orderCount/aov）、
#           shortage.series[]、shortage.summary.shortageRate、topProducts[]（≤10 条，按 subtotal 降序）

# 空数据范围（未来日期）不应 500
curl -s -o /dev/null -w "%{http_code}\n" -H "Authorization: Bearer $TOKEN" "http://localhost:3000/api/analytics/sales-overview?from=2099-01-01&to=2099-01-07"
# Expected: 200（各数组为空，不是 500）
```

- [ ] **Step 4: 提交**

```bash
git add app/api/analytics/sales-overview/route.ts
git commit -m "feat(analytics): add combined sales-overview API route"
```

---

### Task 4: 新增页面 `boss/analytics/sales-overview` 并加入导航

**Files:**
- Create: `app/[locale]/classic/boss/analytics/sales-overview/page.tsx`
- Modify: `app/[locale]/classic/boss/layout.tsx:17-25`

**Interfaces:**
- Consumes: `GET /api/analytics/sales-overview` 响应（Task 3 产出的确切形状）；`DateRangeBar`、`defaultRange`、`eur`、`type DateRange` from `@/components/boss/analytics-shared`

- [ ] **Step 1: 创建页面文件**

创建 `app/[locale]/classic/boss/analytics/sales-overview/page.tsx`：

```typescript
'use client'
import { useState, useEffect, useCallback } from 'react'
import { toast } from 'sonner'
import { apiGet } from '@/lib/api'
import { eur, DateRangeBar, defaultRange, type DateRange } from '@/components/boss/analytics-shared'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, Legend } from 'recharts'

interface DailyPoint { date: string; salesExTax: number; salesIncTax: number; orderCount: number; aov: number }
interface ShortageDayRow { day: string; shortage_lines: number; order_lines: number }
interface TopProduct { productId: string; productName: string; subtotal: number; qty: number }

interface Payload {
  dailySeries: DailyPoint[]
  shortage: { series: ShortageDayRow[]; summary: { shortageLines: number; orderLines: number; shortageRate: number } }
  topProducts: TopProduct[]
}

export default function SalesOverviewPage() {
  const [range, setRange] = useState<DateRange>(defaultRange(7))
  const [data, setData] = useState<Payload | null>(null)

  const load = useCallback((r: DateRange) => {
    setData(null)
    apiGet<Payload>(`/api/analytics/sales-overview?from=${r.from}&to=${r.to}`)
      .then(setData)
      .catch((e) => toast.error(e.message))
  }, [])
  useEffect(() => { load(range) }, [load]) // eslint-disable-line react-hooks/exhaustive-deps

  if (!data) return <div className="text-center text-gray-400 py-24 text-sm">加载中…</div>

  const totalSalesExTax = data.dailySeries.reduce((s, d) => s + d.salesExTax, 0)
  const totalOrders = data.dailySeries.reduce((s, d) => s + d.orderCount, 0)
  const avgAov = totalOrders > 0 ? Math.round((totalSalesExTax / totalOrders) * 100) / 100 : 0

  const salesChartData = data.dailySeries.map((d) => ({
    day: String(d.date).slice(5, 10),
    销售额税前: d.salesExTax,
    销售额税后: d.salesIncTax,
  }))
  const aovChartData = data.dailySeries.map((d) => ({
    day: String(d.date).slice(5, 10),
    客单价: d.aov,
  }))
  const shortageChartData = data.shortage.series.map((d) => ({
    day: String(d.day).slice(5, 10),
    缺货率: d.order_lines > 0 ? Math.round((d.shortage_lines / d.order_lines) * 1000) / 10 : 0,
  }))

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">销售统计</h1>
          <p className="text-sm text-gray-400 mt-0.5">日销售额 / 客单价 / 缺货率趋势 + 关键商品排行 · 历史读每日快照</p>
        </div>
        <DateRangeBar value={range} onChange={(r) => { setRange(r); load(r) }} />
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">期间销售额（税前）</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(totalSalesExTax)}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">期间订单数</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{totalOrders}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">平均客单价</div>
          <div className="text-2xl font-semibold mt-1 tabular-nums">{eur(avgAov)}</div>
        </div>
        <div className="border rounded-lg p-4">
          <div className="text-xs text-gray-500">缺货率</div>
          <div className={`text-2xl font-semibold mt-1 tabular-nums ${data.shortage.summary.shortageRate > 0 ? 'text-red-600' : ''}`}>
            {(data.shortage.summary.shortageRate * 100).toFixed(1)}%
          </div>
          <div className="text-xs text-gray-400 mt-1">{data.shortage.summary.shortageLines} / {data.shortage.summary.orderLines} 行</div>
        </div>
      </div>

      <div className="grid md:grid-cols-2 gap-4">
        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">日销售额趋势</h2>
          {salesChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={salesChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `€${v >= 1000 ? `${(v / 1000).toFixed(0)}k` : v}`} />
                <Tooltip formatter={(v: unknown) => eur(Number(v))} />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Line type="monotone" dataKey="销售额税前" stroke="#875A7B" strokeWidth={2} dot={false} />
                <Line type="monotone" dataKey="销售额税后" stroke="#28a745" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">客单价趋势</h2>
          {aovChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={aovChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `€${v}`} />
                <Tooltip formatter={(v: unknown) => eur(Number(v))} />
                <Line type="monotone" dataKey="客单价" stroke="#875A7B" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">缺货率趋势</h2>
          {shortageChartData.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">暂无数据</div>
          ) : (
            <ResponsiveContainer width="100%" height={220}>
              <LineChart data={shortageChartData} margin={{ top: 5, right: 10, bottom: 0, left: 0 }}>
                <XAxis dataKey="day" fontSize={11} />
                <YAxis fontSize={11} tickFormatter={(v) => `${v}%`} />
                <Tooltip formatter={(v: unknown) => `${v}%`} />
                <Line type="monotone" dataKey="缺货率" stroke="#dc3545" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          )}
        </div>

        <div className="border rounded-lg p-4 bg-white">
          <h2 className="text-sm font-medium text-gray-500 mb-3">关键商品 Top 10（按销售额）</h2>
          {data.topProducts.length === 0 ? (
            <div className="text-center text-gray-400 py-10 text-sm">期内没有销售数据</div>
          ) : (
            <table className="w-full text-sm">
              <thead className="text-left text-gray-400">
                <tr>
                  <th className="py-1 font-medium">#</th>
                  <th className="py-1 font-medium">商品</th>
                  <th className="py-1 font-medium text-right">数量</th>
                  <th className="py-1 font-medium text-right">销售额</th>
                </tr>
              </thead>
              <tbody>
                {data.topProducts.map((p, i) => (
                  <tr key={p.productId} className="border-t">
                    <td className="py-1.5 text-gray-400">{i + 1}</td>
                    <td className="py-1.5">{p.productName}</td>
                    <td className="py-1.5 text-right tabular-nums text-gray-500">{p.qty}</td>
                    <td className="py-1.5 text-right tabular-nums font-medium">{eur(p.subtotal)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  )
}
```

- [ ] **Step 2: 加入导航**

修改 `app/[locale]/classic/boss/layout.tsx` 第 17-25 行，原文：

```typescript
  const LINKS = [
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: '毛利分析' },
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: '物流分析' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: '内控审计' },
  ]
```

改为（新增一行，紧跟在"经营总览"之后）：

```typescript
  const LINKS = [
    { href: `${prefix}/classic/boss`, label: '经营总览' },
    { href: `${prefix}/classic/boss/analytics/sales-overview`, label: '销售统计' },
    { href: `${prefix}/classic/boss/analytics/customers`, label: '客户分析' },
    { href: `${prefix}/classic/boss/analytics/margin`, label: '毛利分析' },
    { href: `${prefix}/classic/boss/analytics/ar-aging`, label: '应收账龄' },
    { href: `${prefix}/classic/boss/analytics/procurement`, label: '采购运营' },
    { href: `${prefix}/classic/boss/analytics/logistics`, label: '物流分析' },
    { href: `${prefix}/classic/boss/analytics/internal-control`, label: '内控审计' },
  ]
```

- [ ] **Step 3: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 4: 启动本地服务，curl + 浏览器验证**

```bash
curl -s -o /dev/null -w "%{http_code}\n" "http://localhost:3000/classic/boss/analytics/sales-overview"
# Expected: 200（页面本身是 client component，未登录会在浏览器里被 layout 的 session 检查重定向，
#           curl 拿到的是 200 的 HTML shell，不是 500）
```

浏览器手动验证：
- 用 BOSS 或 OPERATOR 账号登录，进入"报表 → 销售统计"，确认导航新增了这一项且高亮正确
- 切换 7/30/90 天预设，确认四个图表和 Top10 表格随日期变化
- 自定义日期范围（含未来日期，验证空数据不报错，图表区显示"暂无数据"）

- [ ] **Step 5: 提交**

```bash
git add "app/[locale]/classic/boss/analytics/sales-overview/page.tsx" "app/[locale]/classic/boss/layout.tsx"
git commit -m "feat(analytics): add sales-overview page and nav entry"
```

---

### Task 5: `SalesStats.tsx` 新增客单价/缺货率两张只读汇总卡片

**Files:**
- Modify: `app/[locale]/classic/operator/daily-sales/_components/SalesStats.tsx`

**Interfaces:**
- Consumes: `GET /api/analytics/sales-overview?from&to`（Task 3 产出），只用其 `dailySeries`（求和算全局客单价）和 `shortage.summary.shortageRate`
- 卡片只跟随页面已有的 `fromDate`/`toDate`（第 82-83 行）联动，不跟客户/商品筛选联动

- [ ] **Step 1: 在现有 state 声明区新增一个 state（第 101 行 `allDriverSlots` 之后）**

原文（第 100-101 行）：

```typescript
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [allDriverSlots, setAllDriverSlots] = useState<DriverSlotInfo[]>([])
```

改为：

```typescript
  const [ordersLoading, setOrdersLoading] = useState(false)
  const [allDriverSlots, setAllDriverSlots] = useState<DriverSlotInfo[]>([])
  /** 客单价/缺货率汇总卡片：只跟 fromDate/toDate 联动，不跟客户/商品筛选联动（全局参考值） */
  const [salesOverview, setSalesOverview] = useState<{ aov: number; shortageRate: number } | null>(null)
```

- [ ] **Step 2: 在 `loadOrders` 的 `useEffect` 之后（第 131 行之后）新增一个独立的 `useEffect`**

原文（第 131 行）：

```typescript
  useEffect(() => { loadOrders() }, [loadOrders])
```

改为：

```typescript
  useEffect(() => { loadOrders() }, [loadOrders])

  // 客单价 / 缺货率汇总卡片：跟 fromDate/toDate 走同一个组合 API，保证和「数据分析中心」口径一致
  useEffect(() => {
    if (!fromDate || !toDate) return
    apiGet<{
      dailySeries: Array<{ salesExTax: number; orderCount: number }>
      shortage: { summary: { shortageRate: number } }
    }>(`/api/analytics/sales-overview?from=${fromDate}&to=${toDate}`)
      .then((d) => {
        const totalSales = d.dailySeries.reduce((s, x) => s + x.salesExTax, 0)
        const totalOrders = d.dailySeries.reduce((s, x) => s + x.orderCount, 0)
        setSalesOverview({
          aov: totalOrders > 0 ? Math.round((totalSales / totalOrders) * 100) / 100 : 0,
          shortageRate: d.shortage.summary.shortageRate,
        })
      })
      .catch(() => setSalesOverview(null))
  }, [fromDate, toDate])
```

- [ ] **Step 3: 在"筛选结果"标题区新增两张卡片（原第 576-583 行）**

原文：

```typescript
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {isEn ? 'Filtered Results' : '筛选结果'}
              <span className="ml-2 font-normal normal-case text-gray-400">
                {ordersLoading ? (isEn ? 'Loading…' : '加载中…') : (isEn ? `${reportLines.length} rows · Total ${eur(reportTotal.amount)}` : `${reportLines.length} 行 · 合计 ${eur(reportTotal.amount)}`)}
              </span>
            </span>
```

改为：

```typescript
        <div className="px-5 py-3 flex items-center justify-between gap-3 flex-wrap bg-gray-50 border-b border-gray-100">
          <div className="flex items-center gap-3 flex-wrap">
            <span className="text-xs font-semibold text-gray-500 uppercase tracking-wider">
              {isEn ? 'Filtered Results' : '筛选结果'}
              <span className="ml-2 font-normal normal-case text-gray-400">
                {ordersLoading ? (isEn ? 'Loading…' : '加载中…') : (isEn ? `${reportLines.length} rows · Total ${eur(reportTotal.amount)}` : `${reportLines.length} 行 · 合计 ${eur(reportTotal.amount)}`)}
              </span>
              <span className="ml-3 font-normal normal-case inline-flex items-center gap-1.5">
                <span className="px-2 py-0.5 rounded bg-gray-100 text-gray-600">
                  {isEn ? 'AOV' : '客单价'} {salesOverview ? eur(salesOverview.aov) : '—'}
                </span>
                <span className={`px-2 py-0.5 rounded ${salesOverview && salesOverview.shortageRate > 0 ? 'bg-red-50 text-red-600' : 'bg-gray-100 text-gray-600'}`}>
                  {isEn ? 'Shortage rate' : '缺货率'} {salesOverview ? `${(salesOverview.shortageRate * 100).toFixed(1)}%` : '—'}
                </span>
                <span className="text-gray-400">{isEn ? '(all customers/products)' : '（全部客户/商品）'}</span>
              </span>
            </span>
```

- [ ] **Step 4: 类型检查**

Run: `npx tsc --noEmit`
Expected: 无类型错误

- [ ] **Step 5: 启动本地服务，浏览器手动验证**

- 调度/运营角色登录，进入"日销售管理" → 销售统计 tab
- 确认"筛选结果"标题右侧出现"客单价 ¥xxx.xx"和"缺货率 x.x%（全部客户/商品）"两个灰色徽标
- 切换页面顶部日期范围，确认两个徽标数字随之变化
- 打开 `/classic/boss/analytics/sales-overview`，选同一个日期范围，核对客单价/缺货率数字与 SalesStats 页面完全一致（口径核对，两处应完全相等，因为调用的是同一个 API）
- 左侧勾选具体客户/商品筛选，确认这两个徽标数字**不变**（按设计只跟日期联动）

- [ ] **Step 6: 提交**

```bash
git add "app/[locale]/classic/operator/daily-sales/_components/SalesStats.tsx"
git commit -m "feat(daily-sales): add AOV and shortage-rate summary badges"
```

---

## Self-Review

**Spec coverage：**
- 日销售额趋势 → Task 3（`dailySeries`）+ Task 4（图表）✅
- 客单价趋势 + 全局客单价卡片 → Task 1（`deriveAov`）+ Task 3 + Task 4 + Task 5 ✅
- 缺货率趋势 + 汇总 → Task 2（抽取共享函数，不改变现有路由行为）+ Task 3 + Task 4 + Task 5 ✅
- 关键商品 Top10（按销售额自动排名） → Task 3（`topProducts` 查询）+ Task 4（表格）✅
- 新页面加入数据分析中心导航 → Task 4 Step 2 ✅
- SalesStats 两张卡片只跟日期不跟筛选联动 → Task 5（`useEffect` 依赖数组只有 `[fromDate, toDate]`）✅
- 不下线任何现有入口 → 全程未触碰 `boss/page.tsx` 首页 KPI 卡、`customers` 页面 ABC 表格 ✅
- 缺货率抽取不改变 `/api/analytics/shortage` 响应格式 → Task 2 Step 6 有回归 curl 验证 ✅

**占位符扫描：** 无 TBD / 待补充；所有 Step 都有完整代码块，无"参考 Task N"式引用。

**类型一致性：** `deriveAov(salesExTax: number, orderCount: number): number`（Task 1）与 Task 3、Task 5 里的调用/内联实现保持同一四舍五入规则（`Math.round(x*100)/100`）；`ShortageDailyRow`/`ShortageSummary`（Task 2）与 Task 3 路由里的 `computeShortageDaily`/`summarizeShortageDaily` 调用签名一致；`Payload` 接口（Task 4）字段名与 Task 3 路由实际返回字段（`dailySeries`/`shortage.series`/`shortage.summary`/`topProducts`）逐一对应。
