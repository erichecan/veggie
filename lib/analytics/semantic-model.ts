/**
 * AI 问数 · 指标注册表（20260906）
 * ============================================================================
 * 复用 `lib/analytics/pivot.ts` 的 `DIMENSION_DEFS`（product/category/customer/
 * salesUser/day/week/month）和 `lib/analytics/metrics.ts` 的口径 SSOT——这里
 * 不重新定义维度或规则，只声明"LLM 能选哪个指标、每个指标能暴露哪些真正是
 * 业务选择的可确认参数"。
 *
 * 两类条件的边界（对话讨论敲定）：
 *   - 可确认参数：客户确实有权选的（如税前/税后），每次都摆出来确认
 *   - 锁死规则：只有一个对的答案，不给 LLM/客户选
 *
 * ⛔ 实现前核对 `lib/analytics/metrics.ts` 头部注释后收紧了范围：
 *   - "销售口径 = Order.confirmationDate" 是已经钉死的 SSOT，不是可选项——
 *     dateBasis 不作为可确认参数，固定走 confirmationDate（跟现有毛利/客户
 *     分析页面同一个日期口径，也是交叉验证的基准）。
 *   - "毛利按税前算" 同样是文档写死的规则——grossMargin 不开放 taxBasis，
 *     只有 salesAmount 才有税前/税后可选。
 *   - 计入销售额/毛利的订单状态固定用 `SALES_COUNTED_STATUSES`，不开放选择。
 */
import { DIMENSION_DEFS } from './pivot'

export const CHAT_DIMENSION_KEYS = Object.keys(DIMENSION_DEFS)

export type MetricKey = 'salesAmount' | 'grossMargin'

export type TaxBasis = 'preTax' | 'incTax'

export interface ConfirmableParamDef<T extends string> {
  options: readonly T[]
  default: T
  labelZh: string
  optionLabelsZh: Record<T, string>
}

export type FilterKey = 'customerId' | 'salesUserId' | 'categoryId' | 'productId'

export interface MetricDef {
  key: MetricKey
  labelZh: string
  /** 该指标可确认参数；空对象表示对客户不暴露任何选择（如 grossMargin） */
  confirmableParams: {
    taxBasis?: ConfirmableParamDef<TaxBasis>
  }
  /** 允许分组的维度，直接复用 DIMENSION_DEFS 的 key */
  allowedDimensions: readonly string[]
  /** 允许精确过滤的字段（id 级别等值过滤，不走维度分组） */
  allowedFilters: readonly FilterKey[]
}

const TAX_BASIS_PARAM: ConfirmableParamDef<TaxBasis> = {
  options: ['preTax', 'incTax'],
  default: 'preTax',
  labelZh: '税前/税后口径',
  optionLabelsZh: { preTax: '税前', incTax: '税后（含税）' },
}

export const METRIC_DEFS: Record<MetricKey, MetricDef> = {
  salesAmount: {
    key: 'salesAmount',
    labelZh: '销售额',
    confirmableParams: { taxBasis: TAX_BASIS_PARAM },
    allowedDimensions: CHAT_DIMENSION_KEYS,
    allowedFilters: ['customerId', 'salesUserId', 'categoryId', 'productId'],
  },
  grossMargin: {
    key: 'grossMargin',
    labelZh: '毛利',
    // 毛利恒按税前算（metrics.ts 顶部注释："毛利按税前算"），不给选
    confirmableParams: {},
    allowedDimensions: CHAT_DIMENSION_KEYS,
    allowedFilters: ['customerId', 'salesUserId', 'categoryId', 'productId'],
  },
}

export function getMetricDef(key: string): MetricDef | undefined {
  return (METRIC_DEFS as Record<string, MetricDef>)[key]
}

export function isMetricKey(key: string): key is MetricKey {
  return key === 'salesAmount' || key === 'grossMargin'
}
