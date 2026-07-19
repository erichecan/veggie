/**
 * 单个订单的未税/税额/含税总额计算——从 day-wise-report-template.ts 的
 * buildOrderSummaryHtml() 抽出，供该 PDF 报表和 CSV 导出（订单汇总）共用同一口径，
 * 避免两处各算一遍、税率/subtotal 处理稍有出入就对不上账。
 * 口径参见 memory: sales-accounting-tax-convention——subtotal 恒为税前，taxRate 存百分数。
 */
import type { Order } from '@/lib/types'

export interface OrderTotals {
  untaxed: number
  tax: number
  total: number
}

export function computeOrderTotals(order: Order): OrderTotals {
  let untaxed = 0
  let tax = 0

  const hasLines = order.lines && order.lines.length > 0
  if (hasLines) {
    for (const l of order.lines!) {
      const sub = Number(l.subtotal)
      const rate = Number(l.taxRate ?? 0)
      const normalizedRate = rate > 1 ? rate / 100 : rate
      untaxed += sub
      tax += sub * normalizedRate
    }
  } else {
    for (const it of (order.items ?? [])) {
      const qty = Number(it.quantity ?? 0)
      const price = Number(it.price ?? 0)
      const sub = Number(it.subtotal ?? qty * price)
      const rate = Number(it.taxRate ?? 0)
      const normalizedRate = rate > 1 ? rate / 100 : rate
      untaxed += sub
      tax += sub * normalizedRate
    }
  }

  return { untaxed, tax, total: untaxed + tax }
}
