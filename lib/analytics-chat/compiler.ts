/**
 * AI 问数 · 查询编译器（20260906，20260910 改按 domain 分派 + 明细模式）
 * ============================================================================
 * DSL → 参数化 SQL → 执行。SQL 怎么拼是各 domain 自己的职责（见
 * lib/analytics-chat/domains/*.ts），这里只做：算日期范围 → 找 domain 定义 →
 * 调用对应的 build*Sql → 执行 → 统一做行数护栏/四舍五入。
 * `$queryRawUnsafe` + `$N` 占位符，SQL 片段全部来自代码常量/白名单，
 * 不拼接任何请求参数进 SQL 文本——这条规矩四个 domain 一致遵守。
 */
import { prisma } from '@/lib/db'
import { resolveDateRange } from '@/lib/analytics/metrics'
import { getDomainDef } from './domains'
import type { AnalysisDsl } from './dsl-schema'

/** 行数硬上限：防止理解错的问题（比如维度选了个基数很大的字段）拖垮生产库 */
export const COMPILER_ROW_LIMIT = 500

const round2 = (n: number) => Math.round(n * 100) / 100

/** 比率指标的总计：按各分组样本量（qty）加权平均，不能直接把百分比相加 */
export function weightedAverage(rows: Array<{ value: number; qty: number }>): number {
  const totalQty = rows.reduce((s, r) => s + r.qty, 0)
  if (totalQty === 0) return 0
  const weightedSum = rows.reduce((s, r) => s + r.value * r.qty, 0)
  return weightedSum / totalQty
}

export interface CompiledRow {
  key: string
  name: string
  value: number
  qty: number
  /** 20260912：taxBasis=both 这类"两种口径都要"的查询才会有，其余情况恒为 undefined */
  value2?: number
}

export interface AggregateCompileResult {
  mode: 'aggregate'
  rows: CompiledRow[]
  total: number
  truncated: boolean
  /** 20260912：第二列的合计 + 中文名，只有 metric.secondaryValueLabel 返回非 null 时才有 */
  total2?: number
  secondaryLabel?: string
}

export interface DetailSummaryItem {
  key: string
  labelZh: string
  value: number
}

export interface DetailCompileResult {
  mode: 'detail'
  columns: Array<{ key: string; labelZh: string }>
  rows: Array<Record<string, unknown>>
  /** 20260912：逐行明细的汇总小计（只对 domain 声明了 summable:true 的字段求和，口径与 truncated 一致——只对已取回的行求和） */
  summary: DetailSummaryItem[]
  truncated: boolean
}

export type CompileResult = AggregateCompileResult | DetailCompileResult

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prisma as any

export async function compileAndRun(dsl: AnalysisDsl): Promise<CompileResult> {
  const domainDef = getDomainDef(dsl.domain)
  if (!domainDef) throw new Error(`未知 domain：${dsl.domain}`)

  const { start, end } = resolveDateRange(dsl.dateRange.from ?? null, dsl.dateRange.to ?? null)

  if (dsl.mode === 'detail') {
    if (!domainDef.detail) throw new Error(`"${domainDef.labelZh}"域不支持明细钻取`)
    const { sql, params } = domainDef.detail.buildSql({ filters: dsl.filters, start, end, rowLimit: COMPILER_ROW_LIMIT })
    const rows = (await p.$queryRawUnsafe(sql, ...params)) as Array<Record<string, unknown>>
    const truncated = rows.length > COMPILER_ROW_LIMIT
    const kept = truncated ? rows.slice(0, COMPILER_ROW_LIMIT) : rows
    const summary: DetailSummaryItem[] = domainDef.detail.fields
      .filter((f) => f.summable)
      .map((f) => ({
        key: f.key,
        labelZh: f.labelZh,
        value: round2(kept.reduce((s, r) => s + (Number(r[f.key]) || 0), 0)),
      }))
    return {
      mode: 'detail',
      columns: domainDef.detail.fields.map((f) => ({ key: f.key, labelZh: f.labelZh })),
      rows: kept,
      summary,
      truncated,
    }
  }

  const metricDef = domainDef.metrics[dsl.metric ?? '']
  if (!metricDef) throw new Error(`未知指标：${dsl.metric}`)

  const { sql, params } = domainDef.buildAggregateSql({
    metric: metricDef,
    confirmedParams: dsl.confirmedParams,
    dimension: dsl.dimension,
    filters: dsl.filters,
    start,
    end,
    rowLimit: COMPILER_ROW_LIMIT,
  })

  const rows = (await p.$queryRawUnsafe(sql, ...params)) as Array<{
    row_key: string; row_name: string; qty: number; value: number; value2?: number
  }>

  const truncated = rows.length > COMPILER_ROW_LIMIT
  const kept = truncated ? rows.slice(0, COMPILER_ROW_LIMIT) : rows
  const total = metricDef.aggregationKind === 'rate'
    ? weightedAverage(kept)
    : kept.reduce((s, r) => s + r.value, 0)

  const secondaryLabel = metricDef.secondaryValueLabel?.(dsl.confirmedParams) ?? undefined
  const total2 = secondaryLabel
    ? (metricDef.aggregationKind === 'rate'
        ? weightedAverage(kept.map((r) => ({ value: r.value2 ?? 0, qty: r.qty })))
        : kept.reduce((s, r) => s + (r.value2 ?? 0), 0))
    : undefined

  return {
    mode: 'aggregate',
    rows: kept.map((r) => ({
      key: r.row_key,
      name: r.row_name,
      value: round2(r.value),
      qty: Math.round(r.qty * 1000) / 1000,
      value2: secondaryLabel && r.value2 != null ? round2(r.value2) : undefined,
    })),
    total: round2(total),
    ...(secondaryLabel ? { total2: round2(total2!), secondaryLabel } : {}),
    truncated,
  }
}
