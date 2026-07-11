import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * 运费按行 subtotal 占整单 subtotal 的比例摊入，不依赖重量/件数（菜品单位混用 kg/箱/件时仍成立）。
 * 现算不落库：freightAmount 或行内容改了，落地成本自动跟着变，不需要额外一次"重新摊销"的写操作。
 */

export interface LandedCostLine {
  orderedQty: unknown
  subtotalExTax: unknown
}

export interface LandedCostOrder {
  freightAmount: unknown
  subtotalExTax: unknown
}

export interface LandedCostResult {
  allocatedFreight: number
  landedUnitCost: number
}

export function computeOrderLandedCosts(order: LandedCostOrder, lines: LandedCostLine[]): LandedCostResult[] {
  const freight = toNum(order.freightAmount)
  const orderSubtotal = toNum(order.subtotalExTax)

  return lines.map((line) => {
    const lineSubtotal = toNum(line.subtotalExTax)
    const qty = toNum(line.orderedQty)

    const allocatedFreight = freight > 0 && orderSubtotal > 0
      ? round2(freight * (lineSubtotal / orderSubtotal))
      : 0

    const landedUnitCost = qty > 0
      ? round2((lineSubtotal + allocatedFreight) / qty)
      : 0

    return { allocatedFreight, landedUnitCost }
  })
}
