/**
 * AI 问数 · DSL 校验（20260906，20260910 扩成跨域 + 明细模式）
 * ============================================================================
 * LLM 只允许产出这个形状的 JSON，不允许产出 SQL/代码。这里做两层校验：
 *   1. `parseDsl`：格式校验（字段类型对不对、枚举值合不合法，且必须是这个
 *      domain 真正声明过的 metric/dimension/filter，不是全局白名单）
 *   2. `validateDslSemantics`：业务级校验（维度是否是这个指标允许分组的、
 *      确认参数是否是这个指标声明过的）
 * 两层都过了才交给 compiler 执行；任何一层没过，直接把原因返回，不降级成
 * "凑合跑一个近似查询"。
 *
 * v2 新增 domain（四选一）+ mode（aggregate=聚合 / detail=明细钻取，不分组只
 * 吐行级数据）。⛔ detail 模式**必须**带完整 dateRange——明细查询没有维度分组
 * 收窄结果，行数很容易失控，也是本轮加 Order.confirmationDate 索引要保护的
 * 查询形状（见 DEV-PLAN.md 风险点 3）。
 */
import { getDomainDef, isDomainKey, type DomainKey } from './domains'

export type AnalysisMode = 'aggregate' | 'detail'

export interface AnalysisDsl {
  domain: DomainKey
  mode: AnalysisMode
  /** aggregate 模式必填；detail 模式恒为 null（明细不聚合，没有指标概念） */
  metric: string | null
  confirmedParams: Record<string, string>
  /** null = 不分组，只要一个总计；detail 模式恒为 null（明细模式不支持分组） */
  dimension: string | null
  filters: Record<string, string>
  /** ISO 日期字符串（YYYY-MM-DD）。detail 模式下 from/to 都必填 */
  dateRange: { from?: string; to?: string }
}

export interface DslError {
  message: string
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

/**
 * confirmedParams 的格式校验是全局的（跟 v1 一致），只管"这个 key 的值合不合法枚举"，
 * 不管"这个指标是否声明了这个 key"——那是 validateDslSemantics 的职责（第二层，业务
 * 语义层）。两层分开是故意的：grossMargin 携带 taxBasis 应该"格式合法、语义不合法"，
 * 而不是在格式层就直接拒绝掉，否则 validateDslSemantics 那条"锁死规则"校验永远测不到。
 */
const KNOWN_CONFIRMABLE_PARAMS: Record<string, readonly string[]> = {
  taxBasis: ['preTax', 'incTax'],
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

/** 格式校验：LLM 吐出来的原始 JSON → 类型安全的 AnalysisDsl，或者一条具体的错误原因 */
export function parseDsl(raw: unknown): AnalysisDsl | DslError {
  if (!isPlainObject(raw)) return { message: 'DSL 必须是一个 JSON 对象' }

  const domainRaw = raw.domain
  if (!isDomainKey(domainRaw)) {
    return { message: `domain 必须是 sales/quotation/procurement/delivery 之一，收到：${JSON.stringify(domainRaw)}` }
  }
  const domainDef = getDomainDef(domainRaw)!

  const modeRaw = raw.mode
  const mode: AnalysisMode = modeRaw === 'detail' ? 'detail' : 'aggregate'
  if (modeRaw !== undefined && modeRaw !== null && modeRaw !== 'aggregate' && modeRaw !== 'detail') {
    return { message: `mode 必须是 aggregate 或 detail，收到：${JSON.stringify(modeRaw)}` }
  }
  if (mode === 'detail' && !domainDef.detail) {
    return { message: `"${domainDef.labelZh}"域不支持明细钻取，只能查聚合数字` }
  }

  let metric: string | null = null
  if (mode === 'aggregate') {
    const metricRaw = raw.metric
    if (typeof metricRaw !== 'string' || !domainDef.metrics[metricRaw]) {
      return { message: `metric 必须是 ${Object.keys(domainDef.metrics).join('/')} 之一，收到：${JSON.stringify(metricRaw)}` }
    }
    metric = metricRaw
  }

  const confirmedParamsRaw = raw.confirmedParams
  const confirmedParams: Record<string, string> = {}
  // Gemini 的 responseSchema 标了 nullable 之后，"没有值"有时吐 null 有时干脆不带这个 key，
  // 两种都当"没提供"处理，只有非 null 又不是对象时才算格式错误。
  if (mode === 'aggregate' && confirmedParamsRaw !== undefined && confirmedParamsRaw !== null) {
    if (!isPlainObject(confirmedParamsRaw)) return { message: 'confirmedParams 必须是对象' }
    for (const key of Object.keys(confirmedParamsRaw)) {
      const options = KNOWN_CONFIRMABLE_PARAMS[key]
      const v = confirmedParamsRaw[key]
      if (v === undefined || v === null) continue
      if (!options) return { message: `不认识的确认参数"${key}"` }
      if (typeof v !== 'string' || !options.includes(v)) {
        return { message: `confirmedParams.${key} 必须是 ${options.join('/')} 之一，收到：${JSON.stringify(v)}` }
      }
      confirmedParams[key] = v
    }
  }

  let dimension: string | null = null
  if (mode === 'aggregate') {
    const dimensionRaw = raw.dimension
    if (dimensionRaw !== undefined && dimensionRaw !== null) {
      if (typeof dimensionRaw !== 'string' || !domainDef.dimensions[dimensionRaw]) {
        return { message: `dimension 必须是 ${Object.keys(domainDef.dimensions).join('/')} 之一，或者 null，收到：${JSON.stringify(dimensionRaw)}` }
      }
      dimension = dimensionRaw
    }
  }

  const filtersRaw = raw.filters
  const filters: Record<string, string> = {}
  if (filtersRaw !== undefined && filtersRaw !== null) {
    if (!isPlainObject(filtersRaw)) return { message: 'filters 必须是对象' }
    for (const key of Object.keys(filtersRaw)) {
      if (!(domainDef.filterKeys as readonly string[]).includes(key)) {
        return { message: `"${domainDef.labelZh}"域 filters 不支持字段"${key}"，只能是 ${domainDef.filterKeys.join('/')}` }
      }
      const v = filtersRaw[key]
      if (v !== undefined && typeof v !== 'string') {
        return { message: `filters.${key} 必须是字符串` }
      }
      if (typeof v === 'string' && v) filters[key] = v
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
  if (mode === 'detail' && (!dateRange.from || !dateRange.to)) {
    return { message: '明细查询必须指定完整的日期范围（开始和结束日期都要给），问题里说清楚具体是哪段时间' }
  }

  return { domain: domainRaw, mode, metric, confirmedParams, dimension, filters, dateRange }
}

/** 业务级二次校验：维度/确认参数/筛选字段是否是这个指标真正声明过的 */
export function validateDslSemantics(dsl: AnalysisDsl): DslError | null {
  const domainDef = getDomainDef(dsl.domain)
  if (!domainDef) return { message: `未知 domain：${dsl.domain}` }

  if (dsl.mode === 'detail') {
    for (const key of Object.keys(dsl.filters)) {
      if (!domainDef.filterKeys.includes(key)) {
        return { message: `"${domainDef.labelZh}"域不支持按"${key}"筛选` }
      }
    }
    return null
  }

  const metricDef = domainDef.metrics[dsl.metric ?? '']
  if (!metricDef) return { message: `未知指标：${dsl.metric}` }

  if (dsl.dimension && !metricDef.allowedDimensions.includes(dsl.dimension)) {
    return { message: `指标"${metricDef.labelZh}"不支持按"${dsl.dimension}"分组` }
  }

  for (const key of Object.keys(dsl.confirmedParams)) {
    if (!(key in metricDef.confirmableParams)) {
      return { message: `指标"${metricDef.labelZh}"不支持确认参数"${key}"` }
    }
  }

  for (const key of Object.keys(dsl.filters)) {
    if (!metricDef.allowedFilters.includes(key)) {
      return { message: `指标"${metricDef.labelZh}"不支持按"${key}"筛选` }
    }
  }

  return null
}

/** 把该指标声明的可确认参数缺省值补齐，确保确认文案/编译器看到的是"完整"的一份，而不是"没提就当没有" */
export function fillDefaults(dsl: AnalysisDsl): AnalysisDsl {
  if (dsl.mode === 'detail') return dsl
  const domainDef = getDomainDef(dsl.domain)
  const metricDef = domainDef?.metrics[dsl.metric ?? '']
  if (!metricDef) return dsl
  const confirmedParams = { ...dsl.confirmedParams }
  for (const [key, paramDef] of Object.entries(metricDef.confirmableParams)) {
    if (paramDef && !confirmedParams[key]) confirmedParams[key] = paramDef.default
  }
  return { ...dsl, confirmedParams }
}
