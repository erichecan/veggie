/**
 * AI 问数 · 确认文案模板（20260906，20260910 扩成跨域 + 明细模式）
 * ============================================================================
 * 纯函数：DSL → 人话。**不让 LLM 自由描述查询过程**——这句话是从已经校验通过
 * 的 DSL 用固定模板渲染出来的，保证客户确认的这句话跟实际会执行的查询逻辑
 * 100% 对得上，不会出现"LLM 嘴上说一套、DSL 是另一套"的偏差。
 */
import { getDomainDef, COMPILER_ROW_LIMIT } from './domains'
import type { AnalysisDsl } from './dsl-schema'

function dateRangeText(dsl: AnalysisDsl): string {
  return dsl.dateRange.from || dsl.dateRange.to
    ? `${dsl.dateRange.from ?? '最早'} 至 ${dsl.dateRange.to ?? '今天'}`
    : '最近 30 天（默认区间）'
}

/** from/to 都给了才算得出跨度；跨度越大，明细越容易撞行数护栏——用来判断要不要提前提醒 */
function dateSpanDays(dsl: AnalysisDsl): number | null {
  if (!dsl.dateRange.from || !dsl.dateRange.to) return null
  const ms = new Date(dsl.dateRange.to).getTime() - new Date(dsl.dateRange.from).getTime()
  return Math.round(ms / 86_400_000)
}

/**
 * 20260913：客户反馈"能不能引导问更精确的问题"——明细模式没有维度分组收窄，
 * 时间跨度一大就容易撞 COMPILER_ROW_LIMIT 只拿到"前 N 行"这种不完整结果，
 * 而且客户当下未必看得出来。跨度超过 60 天时提前把这个风险和两个可行的
 * 收窄方向（缩短时间/改问汇总）说清楚，让客户在确认前就能改主意，而不是
 * 等结果被截断了才发现。
 */
const DETAIL_SPAN_WARNING_DAYS = 60

export function renderConfirmationText(dsl: AnalysisDsl): string {
  const domainDef = getDomainDef(dsl.domain)
  const domainLabel = domainDef?.labelZh ?? dsl.domain

  if (dsl.mode === 'detail') {
    const span = dateSpanDays(dsl)
    const spanWarning = span !== null && span > DETAIL_SPAN_WARNING_DAYS
      ? `（时间跨度 ${span} 天，逐行明细最多显示 ${COMPILER_ROW_LIMIT} 行，超过部分会被截断——如果只是想看整体趋势，建议改问"汇总"；需要明细的话把时间范围缩小到你真正关心的那段会更准）`
      : ''
    return `我理解为：查${dateRangeText(dsl)}的"${domainLabel}"明细（逐行列出，并给出汇总小计）${spanWarning}。确认要这样查吗？`
  }

  const metricDef = domainDef?.metrics[dsl.metric ?? '']
  const metricLabel = metricDef?.labelZh ?? dsl.metric

  const clauses: string[] = [dateRangeText(dsl)]

  if (metricDef) {
    for (const [key, def] of Object.entries(metricDef.confirmableParams)) {
      if (!def) continue
      const value = dsl.confirmedParams[key] ?? def.default
      const optionLabel = (def.optionLabelsZh as Record<string, string>)[value] ?? value
      clauses.push(`${def.labelZh}：${optionLabel}`)
    }
  }

  const dimensionText = dsl.dimension
    ? `按${domainDef?.dimensionLabelsZh[dsl.dimension] ?? dsl.dimension}分组`
    : '不分组（只要一个总计）'

  return `我理解为：${clauses.join('，')}的"${domainLabel}"${metricLabel}，${dimensionText}。确认要这样查吗？`
}
