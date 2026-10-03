/**
 * 价格表规则(items 数组里的单条元素)校验/归一化 —— 20261003 从
 * app/api/pricelists/[id]/route.ts 的 normalizeItems 抽出来，供批量导入
 * (app/api/pricelists/bulk/route.ts)复用同一套规则，两边不能各判各的。
 */

export const VALID_APPLY_ON = new Set(['global', 'category', 'product', 'variant'])
export const VALID_COMPUTE = new Set(['fixed', 'percentage', 'formula'])
export const VALID_BASE = new Set(['list_price', 'standard_price', 'pricelist'])

export interface PricelistItemInput {
  id?: string
  applyOn: string
  productTemplateId?: string
  productVariantId?: string
  categoryId?: string
  minQty?: number
  dateStart?: string
  dateEnd?: string
  computeType: string
  fixedPrice?: number
  percentDiscount?: number
  formulaBase?: string
  basedOnPricelistId?: string
  priceDiscount?: number
  priceSurcharge?: number
  priceMinMargin?: number
  priceMaxMargin?: number
  roundingMethod?: number
  sequence?: number
  uomId?: string
  badgeLabel?: string
}

export function newPricelistItemId(): string {
  try {
    return crypto.randomUUID()
  } catch {
    return `item_${Date.now()}_${Math.random().toString(36).slice(2)}`
  }
}

/** 单条规则校验+归一化。非法输入抛出 {status:400, message}，调用方自己决定怎么呈现 */
export function validateAndNormalizeItem(rItem: PricelistItemInput, seenIds: Set<string>): PricelistItemInput {
  const applyOn = String(rItem.applyOn ?? '').toLowerCase()
  const compute = String(rItem.computeType ?? '').toLowerCase()
  if (!VALID_APPLY_ON.has(applyOn)) {
    throw Object.assign(new Error(`applyOn 无效：${rItem.applyOn}`), { status: 400 })
  }
  if (!VALID_COMPUTE.has(compute)) {
    throw Object.assign(new Error(`computeType 无效：${rItem.computeType}`), { status: 400 })
  }

  const minQty = Number(rItem.minQty ?? 0)
  if (!Number.isFinite(minQty) || minQty < 0) {
    throw Object.assign(new Error(`minQty 无效：${rItem.minQty}`), { status: 400 })
  }
  if (compute === 'fixed') {
    const fp = Number(rItem.fixedPrice ?? 0)
    if (!Number.isFinite(fp) || fp < 0 || fp > 1_000_000) {
      throw Object.assign(new Error(`fixedPrice 范围无效：${rItem.fixedPrice}`), { status: 400 })
    }
  }
  if (compute === 'percentage') {
    const pd = Number(rItem.percentDiscount ?? 0)
    if (!Number.isFinite(pd) || pd < -100 || pd > 100) {
      throw Object.assign(new Error(`percentDiscount 应在 -100~100：${rItem.percentDiscount}`), { status: 400 })
    }
  }
  if (compute === 'formula') {
    const base = String(rItem.formulaBase ?? 'list_price').toLowerCase()
    if (!VALID_BASE.has(base)) {
      throw Object.assign(new Error(`formulaBase 无效：${rItem.formulaBase}`), { status: 400 })
    }
    if (base === 'pricelist' && !rItem.basedOnPricelistId) {
      throw Object.assign(new Error('formulaBase=pricelist 时 basedOnPricelistId 必填'), { status: 400 })
    }
  }

  let id = typeof rItem.id === 'string' && rItem.id.trim() !== '' ? rItem.id : newPricelistItemId()
  if (seenIds.has(id)) id = newPricelistItemId()
  seenIds.add(id)

  // uomId 只对 product/variant 有意义(决策#4)：category/global 传了也一律丢弃
  const uomId = (applyOn === 'product' || applyOn === 'variant') && typeof rItem.uomId === 'string' && rItem.uomId.trim() !== ''
    ? rItem.uomId
    : undefined

  return { ...rItem, id, minQty, applyOn, computeType: compute, uomId }
}

/** 整份 items 数组校验+归一化(PUT /api/pricelists/[id] 用这个) */
export function normalizeItems(raw: unknown): PricelistItemInput[] {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: PricelistItemInput[] = []
  for (const rItem of raw as PricelistItemInput[]) {
    if (!rItem || typeof rItem !== 'object') continue
    out.push(validateAndNormalizeItem(rItem, seen))
  }
  return out
}
