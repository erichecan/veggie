/**
 * AI 问数 · 确认文案模板（20260906，20260910 扩成跨域 + 明细模式）
 * ============================================================================
 * 纯函数：DSL → 人话。**不让 LLM 自由描述查询过程**——这句话是从已经校验通过
 * 的 DSL 用固定模板渲染出来的，保证客户确认的这句话跟实际会执行的查询逻辑
 * 100% 对得上，不会出现"LLM 嘴上说一套、DSL 是另一套"的偏差。
 */
import { getDomainDef } from './domains'
import type { AnalysisDsl } from './dsl-schema'

function dateRangeText(dsl: AnalysisDsl): string {
  return dsl.dateRange.from || dsl.dateRange.to
    ? `${dsl.dateRange.from ?? '最早'} 至 ${dsl.dateRange.to ?? '今天'}`
    : '最近 30 天（默认区间）'
}

export function renderConfirmationText(dsl: AnalysisDsl): string {
  const domainDef = getDomainDef(dsl.domain)
  const domainLabel = domainDef?.labelZh ?? dsl.domain

  if (dsl.mode === 'detail') {
    return `我理解为：查${dateRangeText(dsl)}的"${domainLabel}"明细（逐行列出，不做汇总）。确认要这样查吗？`
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
