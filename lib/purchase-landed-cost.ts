import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * 运费按行订购数量占比摊入（20261017 客户需求：总运费/总箱数=每箱分摊费用，退化成按数量比例，
 * 兼容混用 KG/箱/个等不同采购单位的情况）。此前按行金额占比，客户截图明确要求按数量，已改。
 * computeOrderLandedCosts 用于编辑页/新建页实时预览，现算不落库，不区分商品类型。
 * computeFreightAllocationForConfirm 用于「确认采购」时的真实分摊并落库：排除 SERVICE 类行、
 * 支持操作员手动覆盖单行金额、剩余部分按数量比例分给未覆盖的行，整除不尽的尾差由最后一个自动行吸收。
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
  const totalQty = lines.reduce((s, l) => s + toNum(l.orderedQty), 0)

  return lines.map((line) => {
    const lineSubtotal = toNum(line.subtotalExTax)
    const qty = toNum(line.orderedQty)

    const allocatedFreight = freight > 0 && totalQty > 0
      ? round2(freight * (qty / totalQty))
      : 0

    const landedUnitCost = qty > 0
      ? round2((lineSubtotal + allocatedFreight) / qty)
      : 0

    return { allocatedFreight, landedUnitCost }
  })
}

export interface FreightAllocationLine {
  id: string
  orderedQty: unknown
  /** ProductSaleUom.factor（1 本单位 = factor 个基础单位，按 productId+uomId 维度，⛔不是全局 Uom.factor）；
   * 同一采购单里各行下单单位不统一（箱/公斤混用）时，分摊基数必须先换算成基础单位再比例分，
   * 否则「2 箱」和「10 公斤」被当成同一个数直接比没有意义（20261017 客户确认）。
   * 缺失或 <=0 时按 1 处理（即退化为直接用 orderedQty，兼容历史没配 factor 的数据）。 */
  uomFactor: unknown
  /** Product.type === 'SERVICE'：恒分摊 0，不进分摊基数 */
  isService: boolean
  /** 当前已持久化的 PurchaseOrderLine.allocatedFreightEur；非 null/undefined = 操作员手动覆盖过，按原值生效 */
  manualAllocatedFreightEur: unknown
}

export interface FreightAllocationResult {
  id: string
  allocatedFreightEur: number
}

export function computeFreightAllocationForConfirm(
  freightAmountEur: unknown,
  lines: FreightAllocationLine[],
): FreightAllocationResult[] {
  const freight = round2(toNum(freightAmountEur))

  const results: FreightAllocationResult[] = []
  const autoLines: { id: string; qty: number }[] = []
  let manualTotal = 0

  for (const line of lines) {
    if (line.isService) {
      results.push({ id: line.id, allocatedFreightEur: 0 })
      continue
    }
    if (line.manualAllocatedFreightEur !== null && line.manualAllocatedFreightEur !== undefined) {
      const manual = round2(toNum(line.manualAllocatedFreightEur))
      manualTotal += manual
      results.push({ id: line.id, allocatedFreightEur: manual })
      continue
    }
    const factor = toNum(line.uomFactor)
    const baseQty = toNum(line.orderedQty) * (factor > 0 ? factor : 1)
    autoLines.push({ id: line.id, qty: baseQty })
  }

  const remaining = round2(freight - manualTotal)
  const totalAutoQty = autoLines.reduce((s, l) => s + l.qty, 0)

  if (autoLines.length > 0 && totalAutoQty > 0) {
    let allocated = 0
    autoLines.forEach((l, idx) => {
      const isLast = idx === autoLines.length - 1
      const share = isLast ? round2(remaining - allocated) : round2(remaining * (l.qty / totalAutoQty))
      allocated += share
      results.push({ id: l.id, allocatedFreightEur: share })
    })
  } else {
    for (const l of autoLines) results.push({ id: l.id, allocatedFreightEur: 0 })
  }

  return results
}

/** 落地单价 = (本行税前小计 + 分摊运费) / 订购数量；SERVICE 行或数量为 0 时返回 0 */
export function computeLandedUnitCost(subtotalExTaxEur: unknown, allocatedFreightEur: unknown, orderedQty: unknown): number {
  const qty = toNum(orderedQty)
  if (qty <= 0) return 0
  return round2((toNum(subtotalExTaxEur) + toNum(allocatedFreightEur)) / qty)
}
