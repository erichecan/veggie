/**
 * Shared sales-order product grouping and quantity summaries.
 * Group order follows the first appearance of each product; lines inside a product
 * group keep their original sequence. This keeps the operator's order intuitive
 * while bringing duplicate product lines together.
 */

export interface QuantitySummaryLine {
  id?: string
  productId?: string | null
  productName: string
  uomId?: string | null
  uomName?: string | null
  orderedQty: unknown
  uomConversion?: {
    factor: number
    baseUomName: string
  } | null
}

export interface ProductLineGroup<T extends QuantitySummaryLine> {
  key: string
  productId: string | null
  productName: string
  lines: T[]
  salesUnitQuantity: string
  baseUnitQuantity: string | null
  baseUomName: string | null
}

function lineKey(line: QuantitySummaryLine, index: number): string {
  // Legacy lines without productId cannot safely be assumed to be the same product.
  return line.productId ? `product:${line.productId}` : `line:${line.id ?? index}`
}

export function formatOrderQuantity(value: number): string {
  if (!Number.isFinite(value)) return '0'
  const formatted = value.toFixed(3).replace(/\.?0+$/, '')
  return formatted === '' || formatted === '-0' ? '0' : formatted
}

export function groupOrderLines<T extends QuantitySummaryLine>(lines: readonly T[]): ProductLineGroup<T>[] {
  const groups = new Map<string, T[]>()
  for (const [index, line] of lines.entries()) {
    const key = lineKey(line, index)
    const group = groups.get(key)
    if (group) group.push(line)
    else groups.set(key, [line])
  }

  return Array.from(groups, ([key, groupLines]) => {
    const unitTotals = new Map<string, number>()
    let baseTotal = 0
    let baseUomName: string | null = null
    let hasCompleteBaseConversion = groupLines.length > 0

    for (const line of groupLines) {
      const unit = line.uomName?.trim() || '—'
      const qty = Number(line.orderedQty) || 0
      unitTotals.set(unit, (unitTotals.get(unit) ?? 0) + qty)

      const conversion = line.uomConversion
      if (!conversion || !Number.isFinite(Number(conversion.factor)) || !conversion.baseUomName) {
        hasCompleteBaseConversion = false
        continue
      }
      if (baseUomName && baseUomName !== conversion.baseUomName) {
        hasCompleteBaseConversion = false
        continue
      }
      baseUomName = conversion.baseUomName
      baseTotal += qty * Number(conversion.factor)
    }

    return {
      key,
      productId: groupLines[0]?.productId ?? null,
      productName: groupLines[0]?.productName ?? '',
      lines: groupLines,
      salesUnitQuantity: Array.from(unitTotals, ([unit, qty]) => `${formatOrderQuantity(qty)} ${unit}`).join(' + '),
      baseUnitQuantity: hasCompleteBaseConversion && baseUomName ? formatOrderQuantity(baseTotal) : null,
      baseUomName: hasCompleteBaseConversion ? baseUomName : null,
    }
  })
}

export function flattenOrderLineGroups<T extends QuantitySummaryLine>(groups: readonly ProductLineGroup<T>[]): T[] {
  return groups.flatMap(group => group.lines)
}
