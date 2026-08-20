import { round2 } from '@/lib/decimal-helpers'

/**
 * 商品可售单位（多规格）的校验与换算 —— 唯一口径
 * ============================================================================
 * 20260819 起，换算系数 `factor` 挂在 `ProductSaleUom` 上，不再用全局 `Uom.factor`。
 *
 * 为什么：`ASIAN CHOICE Black Tiger Shrimp 10*700g CASE`（箱装 10 包）与
 * `Chuannan Pickled Vegetable 30*62g CASE`（箱装 30 包）在生产库里都叫 CASE。
 * 「1 CASE 等于多少」是**商品**的属性。全局 Uom.factor 在生产库 Unit 类目下
 * 干脆全是 1，多规格因此形同虚设 —— 切了单位价格不变、库存也不换算。
 *
 * 库存口径（客户 20260819 拍板）：`Product.qtyOnHand` 按**基础单位**计数，
 * 基础单位 = `isDefault` 那一行，其 factor 恒为 1。
 */

export interface SaleUomItemInput {
  uomId?: string
  isDefault?: boolean
  /** 1 个此单位 = factor 个基础单位 */
  factor?: number | string | null
  priceOverride?: number | string | null
  active?: boolean
}

/** factor 的合理区间。上限 100000 足够覆盖「1 托盘 = N 个最小包装」这类真实场景 */
const FACTOR_MIN = 0.000001
const FACTOR_MAX = 100000

/**
 * 校验一组可售单位配置：单位不重复、恰好一个默认、默认单位系数必须为 1、
 * 其余系数与独立售价在合理区间。返回错误信息，无误返回 null。
 */
export function validateSaleUomItems(items: SaleUomItemInput[]): string | null {
  const uomIds = items.map(it => String(it.uomId ?? ''))
  if (new Set(uomIds).size !== uomIds.length) return '同一单位不能重复配置'
  const defaultCount = items.filter(it => it.isDefault).length
  if (items.length > 0 && defaultCount !== 1) return '必须且只能有一个默认单位'

  for (const it of items) {
    if (!it.uomId) return '单位不能为空'

    if (it.priceOverride != null && it.priceOverride !== '') {
      const n = Number(it.priceOverride)
      if (!Number.isFinite(n) || n < 0 || n > 1000000) return '独立售价必须在 0–1,000,000 之间'
    }

    const f = it.factor == null || it.factor === '' ? 1 : Number(it.factor)
    if (!Number.isFinite(f) || f < FACTOR_MIN || f > FACTOR_MAX) {
      return `换算系数必须在 ${FACTOR_MIN} – ${FACTOR_MAX} 之间`
    }
    // 基础单位是库存的计数尺子，它自己对自己的换算只能是 1。
    // 允许填别的值等于让「1 包 = 2 包」，库存会立刻算错。
    if (it.isDefault && f !== 1) return '默认单位就是库存的计数单位，换算系数必须为 1'
  }
  return null
}

/** 从输入里取出规范化的 factor（空/非法一律回落到 1，与改造前行为一致） */
export function normalizeFactor(raw: number | string | null | undefined): number {
  if (raw == null || raw === '') return 1
  const n = Number(raw)
  if (!Number.isFinite(n) || n < FACTOR_MIN || n > FACTOR_MAX) return 1
  return n
}

export interface SaleUomRow {
  uomId: string
  isDefault: boolean
  factor: number
  priceOverride: number | null
  active?: boolean
}

/**
 * 某一行选用 `lineUomId` 时，1 个该单位等于多少个基础单位。
 *
 * 没配多规格、或选的就是基础单位 → 返回 1（与多规格上线前逐字一致，
 * 5474 个从未配过多规格的商品完全不受影响）。
 */
export function factorOf(saleUoms: SaleUomRow[], lineUomId: string | null | undefined): number {
  if (!lineUomId || saleUoms.length === 0) return 1
  const hit = saleUoms.find(r => r.uomId === lineUomId)
  if (!hit) return 1
  return hit.factor > 0 ? hit.factor : 1
}

/**
 * 某一行选用 `lineUomId` 时的单价。
 *
 * `priceOverride` 优先（整箱优惠价这类场景），否则按「基础单价 × factor」换算。
 */
export function priceOf(
  saleUoms: SaleUomRow[],
  lineUomId: string | null | undefined,
  basePrice: number,
): number {
  if (!lineUomId || saleUoms.length === 0) return basePrice
  const hit = saleUoms.find(r => r.uomId === lineUomId)
  if (!hit) return basePrice
  if (hit.priceOverride != null) return hit.priceOverride
  // ⚠️ 必须舍入：1.20 × 3 在浮点里是 3.5999999999999996。
  // 落库时 Decimal(12,2) 会截断掉，但界面上会**原样显示**这一串 ——
  // 客户看到报价单上写 €3.5999999999999996 就没法用了。
  return round2(basePrice * (hit.factor > 0 ? hit.factor : 1))
}

/** 基础单位（库存计数单位）；没配多规格时为 null */
export function baseUomId(saleUoms: SaleUomRow[]): string | null {
  return saleUoms.find(r => r.isDefault)?.uomId ?? null
}
