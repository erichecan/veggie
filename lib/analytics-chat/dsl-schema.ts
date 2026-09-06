/**
 * AI 问数 · DSL 校验（20260906）
 * ============================================================================
 * LLM 只允许产出这个形状的 JSON，不允许产出 SQL/代码。这里做两层校验：
 *   1. `parseDsl`：格式校验（字段类型对不对、枚举值合不合法）——Gemini 走
 *      `responseSchema` 已经卡过一次，这里是不信任模型守约的第二道防线。
 *   2. `validateDslSemantics`：业务级校验（维度是否是这个指标允许分组的、
 *      确认参数是否是这个指标声明过的）——格式对不代表语义对，比如给
 *      grossMargin 塞一个它没声明过的 taxBasis。
 * 两层都过了才交给 compiler 执行；任何一层没过，直接把原因返回，不降级成
 * "凑合跑一个近似查询"。
 */
import { getMetricDef, CHAT_DIMENSION_KEYS, type MetricKey, type TaxBasis } from '../analytics/semantic-model'

export interface AnalysisDsl {
  metric: MetricKey
  confirmedParams: { taxBasis?: TaxBasis }
  /** null = 不分组，只要一个总计 */
  dimension: string | null
  filters: {
    customerId?: string
    salesUserId?: string
    categoryId?: string
    productId?: string
  }
  /** ISO 日期字符串（YYYY-MM-DD），缺省时 compiler 走 resolveDateRange 的默认区间 */
  dateRange: { from?: string; to?: string }
}

export interface DslError {
  message: string
}

const FILTER_KEYS = ['customerId', 'salesUserId', 'categoryId', 'productId'] as const
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 格式校验：LLM 吐出来的原始 JSON → 类型安全的 AnalysisDsl，或者一条具体的错误原因 */
export function parseDsl(raw: unknown): AnalysisDsl | DslError {
  if (!isPlainObject(raw)) return { message: 'DSL 必须是一个 JSON 对象' }

  const metric = raw.metric
  if (metric !== 'salesAmount' && metric !== 'grossMargin') {
    return { message: `metric 必须是 salesAmount 或 grossMargin，收到：${JSON.stringify(metric)}` }
  }

  const confirmedParamsRaw = raw.confirmedParams
  const confirmedParams: AnalysisDsl['confirmedParams'] = {}
  // Gemini 的 responseSchema 标了 nullable 之后，"没有值"有时吐 null 有时干脆不带这个 key，
  // 两种都当"没提供"处理，只有非 null 又不是对象时才算格式错误。
  if (confirmedParamsRaw !== undefined && confirmedParamsRaw !== null) {
    if (!isPlainObject(confirmedParamsRaw)) return { message: 'confirmedParams 必须是对象' }
    if (confirmedParamsRaw.taxBasis !== undefined) {
      if (confirmedParamsRaw.taxBasis !== 'preTax' && confirmedParamsRaw.taxBasis !== 'incTax') {
        return { message: `confirmedParams.taxBasis 必须是 preTax 或 incTax，收到：${JSON.stringify(confirmedParamsRaw.taxBasis)}` }
      }
      confirmedParams.taxBasis = confirmedParamsRaw.taxBasis
    }
  }

  const dimensionRaw = raw.dimension
  let dimension: string | null = null
  if (dimensionRaw !== undefined && dimensionRaw !== null) {
    if (typeof dimensionRaw !== 'string' || !CHAT_DIMENSION_KEYS.includes(dimensionRaw)) {
      return { message: `dimension 必须是 ${CHAT_DIMENSION_KEYS.join('/')} 之一，或者 null，收到：${JSON.stringify(dimensionRaw)}` }
    }
    dimension = dimensionRaw
  }

  const filtersRaw = raw.filters
  const filters: AnalysisDsl['filters'] = {}
  if (filtersRaw !== undefined && filtersRaw !== null) {
    if (!isPlainObject(filtersRaw)) return { message: 'filters 必须是对象' }
    for (const key of Object.keys(filtersRaw)) {
      if (!(FILTER_KEYS as readonly string[]).includes(key)) {
        return { message: `filters 不支持字段"${key}"，只能是 ${FILTER_KEYS.join('/')}` }
      }
      const v = filtersRaw[key]
      if (v !== undefined && typeof v !== 'string') {
        return { message: `filters.${key} 必须是字符串` }
      }
      if (typeof v === 'string' && v) filters[key as (typeof FILTER_KEYS)[number]] = v
    }
  }

  const dateRangeRaw = raw.dateRange
  const dateRange: AnalysisDsl['dateRange'] = {}
  if (dateRangeRaw !== undefined && dateRangeRaw !== null) {
    if (!isPlainObject(dateRangeRaw)) return { message: 'dateRange 必须是对象' }
    for (const key of ['from', 'to'] as const) {
      const v = dateRangeRaw[key]
      if (v === undefined || v === null) continue
      if (typeof v !== 'string' || !DATE_RE.test(v)) {
        return { message: `dateRange.${key} 必须是 YYYY-MM-DD 格式的字符串` }
      }
      dateRange[key] = v
    }
  }

  return { metric, confirmedParams, dimension, filters, dateRange }
}

/** 业务级二次校验：维度/确认参数/筛选字段是否是这个指标真正声明过的 */
export function validateDslSemantics(dsl: AnalysisDsl): DslError | null {
  const metricDef = getMetricDef(dsl.metric)
  if (!metricDef) return { message: `未知指标：${dsl.metric}` }

  if (dsl.dimension && !metricDef.allowedDimensions.includes(dsl.dimension)) {
    return { message: `指标"${metricDef.labelZh}"不支持按"${dsl.dimension}"分组` }
  }

  for (const key of Object.keys(dsl.confirmedParams) as Array<keyof AnalysisDsl['confirmedParams']>) {
    if (!(key in metricDef.confirmableParams)) {
      return { message: `指标"${metricDef.labelZh}"不支持确认参数"${key}"` }
    }
  }

  for (const key of Object.keys(dsl.filters)) {
    if (!metricDef.allowedFilters.includes(key as (typeof FILTER_KEYS)[number])) {
      return { message: `指标"${metricDef.labelZh}"不支持按"${key}"筛选` }
    }
  }

  return null
}

/** 把该指标声明的可确认参数缺省值补齐，确保确认文案/编译器看到的是"完整"的一份，而不是"没提就当没有" */
export function fillDefaults(dsl: AnalysisDsl): AnalysisDsl {
  const metricDef = getMetricDef(dsl.metric)
  if (!metricDef) return dsl
  const confirmedParams = { ...dsl.confirmedParams }
  if (metricDef.confirmableParams.taxBasis && !confirmedParams.taxBasis) {
    confirmedParams.taxBasis = metricDef.confirmableParams.taxBasis.default
  }
  return { ...dsl, confirmedParams }
}
