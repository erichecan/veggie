/**
 * AI 问数 v2 · 跨域类型定义（20260910）
 * ============================================================================
 * v1（20260906）硬编码单一 sales domain。v2 加 quotation/procurement/delivery
 * 三个域 + 明细钻取（mode），每个域的 SQL 结构差异很大（sales/procurement 是
 * 干净的两表 JOIN，quotation 只查 Order 一张表，delivery 要 unnest JSON 数组），
 * 所以把"怎么拼 SQL"的职责下放到各域自己的文件里，这里只定义共享的形状。
 */

export type DomainKey = 'sales' | 'quotation' | 'procurement' | 'delivery'

export const DOMAIN_KEYS: readonly DomainKey[] = ['sales', 'quotation', 'procurement', 'delivery']

export function isDomainKey(v: unknown): v is DomainKey {
  return typeof v === 'string' && (DOMAIN_KEYS as readonly string[]).includes(v)
}

export interface DimensionDef {
  keyExpr: string
  nameExpr: string
  extraJoin: string
  isTimeBucket: boolean
}

export interface ConfirmableParamDef<T extends string = string> {
  options: readonly T[]
  default: T
  labelZh: string
  optionLabelsZh: Record<T, string>
}

export interface MetricDef {
  key: string
  labelZh: string
  /** 该指标可确认参数；空对象表示对客户不暴露任何选择 */
  confirmableParams: Record<string, ConfirmableParamDef | undefined>
  allowedDimensions: readonly string[]
  allowedFilters: readonly string[]
  /**
   * 总计怎么算：'sum'（默认）= 各分组 value 直接相加，适用于金额/数量这类可加指标；
   * 'rate' = 按 qty（各分组的样本量）加权平均，适用于转化率这类比率指标——
   * 直接把几个百分比加起来是错的（20260910 实测：分 8 组的转化率求和吐出
   * "737.82%" 这种没有业务含义的数字，改成 Σ(qty·value)/Σqty 才对）。
   */
  aggregationKind?: 'sum' | 'rate'
  /**
   * 20260912：某些确认参数选了"都要"（如 taxBasis=both）时，SQL 会多吐一列
   * `value2`，这里给它起个中文名；返回 null 表示这次查询不需要第二列。
   * 不用这个函数就永远不会有第二列，其余指标不受影响。
   */
  secondaryValueLabel?: (confirmedParams: Record<string, string | undefined>) => string | null
}

export interface DetailFieldDef {
  key: string
  labelZh: string
  /** 20260912：该字段是否要在明细结果里给一个汇总小计（金额/数量类打 true，客户名等文本字段不要打） */
  summable?: boolean
}

export interface SqlQuery {
  sql: string
  params: unknown[]
}

export interface AggregateSqlArgs {
  metric: MetricDef
  confirmedParams: Record<string, string | undefined>
  dimension: string | null
  filters: Record<string, string | undefined>
  start: Date
  end: Date
  rowLimit: number
}

export interface DetailSqlArgs {
  filters: Record<string, string | undefined>
  start: Date
  end: Date
  rowLimit: number
}

export interface DomainDef {
  key: DomainKey
  labelZh: string
  metrics: Record<string, MetricDef>
  dimensions: Record<string, DimensionDef>
  dimensionLabelsZh: Record<string, string>
  filterKeys: readonly string[]
  filterLabelsZh: Record<string, string>
  buildAggregateSql: (args: AggregateSqlArgs) => SqlQuery
  /** 不声明 = 该域不支持明细钻取（v2 四个域目前全部支持，字段保留是为了未来可能收窄） */
  detail?: {
    fields: DetailFieldDef[]
    buildSql: (args: DetailSqlArgs) => SqlQuery
  }
}

export function getMetricDef(domain: DomainDef, key: string): MetricDef | undefined {
  return domain.metrics[key]
}
