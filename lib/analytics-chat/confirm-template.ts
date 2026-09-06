/**
 * AI 问数 · 确认文案模板（20260906）
 * ============================================================================
 * 纯函数：DSL → 人话。**不让 LLM 自由描述查询过程**——这句话是从已经校验通过
 * 的 DSL 用固定模板渲染出来的，保证客户确认的这句话跟实际会执行的查询逻辑
 * 100% 对得上，不会出现"LLM 嘴上说一套、DSL 是另一套"的偏差。
 *
 * 必须列出该指标声明的**每一个**可确认参数，不能只列客户这句话里提到过的——
 * 客户往往意识不到这里有歧义（比如没提税前税后），只有把默认值也亮出来
 * （"我按税前口径统计的，需要改成含税吗？"），他才有机会发现问题。
 */
import { getMetricDef } from '../analytics/semantic-model'
import type { AnalysisDsl } from './dsl-schema'

const DIMENSION_LABELS_ZH: Record<string, string> = {
  product: '商品', category: '分类', customer: '客户', salesUser: '业务员',
  day: '日', week: '周', month: '月',
}

export function renderConfirmationText(dsl: AnalysisDsl): string {
  const metricDef = getMetricDef(dsl.metric)
  const metricLabel = metricDef?.labelZh ?? dsl.metric

  const clauses: string[] = []

  clauses.push(
    dsl.dateRange.from || dsl.dateRange.to
      ? `${dsl.dateRange.from ?? '最早'} 至 ${dsl.dateRange.to ?? '今天'}`
      : '最近 30 天（默认区间）',
  )

  if (metricDef) {
    for (const [key, def] of Object.entries(metricDef.confirmableParams)) {
      if (!def) continue
      const raw = dsl.confirmedParams[key as keyof AnalysisDsl['confirmedParams']]
      const value = raw ?? def.default
      const optionLabel = (def.optionLabelsZh as Record<string, string>)[value] ?? value
      clauses.push(`${def.labelZh}：${optionLabel}`)
    }
  }

  const dimensionText = dsl.dimension
    ? `按${DIMENSION_LABELS_ZH[dsl.dimension] ?? dsl.dimension}分组`
    : '不分组（只要一个总计）'

  return `我理解为：${clauses.join('，')}的${metricLabel}，${dimensionText}。确认要这样查吗？`
}
