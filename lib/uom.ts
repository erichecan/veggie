/**
 * Unit of Measure 换算工具
 * ============================================================================
 * 对标 Odoo 的 uom._compute_quantity() / _compute_price()。
 *
 * 核心规则：
 *   - 只能在同一 Category 内换算
 *   - 数量换算：qty_to = qty_from × (factor_from / factor_to)
 *   - 单价换算：price_to = price_from × (factor_to / factor_from)
 *     （价格和数量换算方向相反，总金额不变）
 *
 * 常见业务：
 *   - 采购 1 CASE (factor=10, 相当于 10kg) 单价 €35 → 销售 1 kg 单价应当是 €3.5
 *   - 库存 100 kg → 按 10kg BAG 显示 = 10 BAG
 */

export interface UomLike {
  id: string
  name: string
  categoryId: string
  factor: number
  rounding: number
}

/** 不同 Category 之间无法换算时抛出 */
export class UomMismatchError extends Error {
  constructor(fromCat: string, toCat: string) {
    super(`UoM category mismatch: ${fromCat} ≠ ${toCat}`)
  }
}

/**
 * 把 qty (in uomFrom) 换算成 qty (in uomTo)
 * @param roundTo 是否按目标 UoM 的 rounding 精度取整
 */
export function convertQty(
  qty: number,
  uomFrom: UomLike,
  uomTo: UomLike,
  roundTo = true,
): number {
  if (uomFrom.id === uomTo.id) return qty
  if (uomFrom.categoryId !== uomTo.categoryId) {
    throw new UomMismatchError(uomFrom.categoryId, uomTo.categoryId)
  }
  const raw = qty * (uomFrom.factor / uomTo.factor)
  if (!roundTo || uomTo.rounding <= 0) return raw
  return Math.round(raw / uomTo.rounding) * uomTo.rounding
}

/**
 * 把 price (per uomFrom) 换算成 price (per uomTo)
 * 注意：价格和数量的比例正好相反（总金额守恒）
 */
export function convertPrice(
  price: number,
  uomFrom: UomLike,
  uomTo: UomLike,
): number {
  if (uomFrom.id === uomTo.id) return price
  if (uomFrom.categoryId !== uomTo.categoryId) {
    throw new UomMismatchError(uomFrom.categoryId, uomTo.categoryId)
  }
  return price * (uomTo.factor / uomFrom.factor)
}

/**
 * 给定一批 UoM，把 qty 尽量表示成"大单位 + 余数小单位"的人类可读字符串
 * 例如：225kg → "22 × 10kg BAG + 5 kg"
 */
export function prettyQty(
  qty: number,
  refUom: UomLike,
  candidateUoms: UomLike[],
): string {
  const sameCat = candidateUoms.filter(u => u.categoryId === refUom.categoryId)
  const bigger = sameCat
    .filter(u => u.factor > refUom.factor)
    .sort((a, b) => b.factor - a.factor)
  if (bigger.length === 0) {
    return `${qty} ${refUom.name}`
  }
  const parts: string[] = []
  let remain = qty
  for (const big of bigger) {
    const ratio = big.factor / refUom.factor
    const count = Math.floor(remain / ratio)
    if (count > 0) {
      parts.push(`${count} × ${big.name}`)
      remain -= count * ratio
    }
  }
  if (remain > 0) {
    const rounded = Math.round(remain / refUom.rounding) * refUom.rounding
    parts.push(`${rounded} ${refUom.name}`)
  }
  return parts.join(' + ') || `0 ${refUom.name}`
}
