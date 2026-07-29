export interface SaleUomItemInput {
  uomId?: string
  isDefault?: boolean
  priceOverride?: number | string | null
  active?: boolean
}

/** 校验一组可售单位(ProductSaleUom)配置：单位不重复、恰好一个默认、独立售价在合理区间。返回错误信息，无误返回 null。 */
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
  }
  return null
}
