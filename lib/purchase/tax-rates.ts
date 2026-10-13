/**
 * 采购单税率 SSOT —— 爱尔兰增值税只有这三档（0% 免税、13.5% 低税率、23% 标准税率），
 * 新建/编辑采购单的税率输入框统一收口成下拉选择，不再允许手输任意数字。
 * 单位是百分数（23 表示 23%），与 PurchaseOrderLine.taxRate / subtotalExTax * taxRate / 100 的算法保持一致。
 */
export const PURCHASE_TAX_RATES = [0, 13.5, 23] as const

export function isValidPurchaseTaxRate(rate: number): boolean {
  return PURCHASE_TAX_RATES.some(r => Math.abs(r - rate) < 1e-9)
}

/** 历史数据（复制历史单/PDF 识别）税率可能不在这三档里，取最近的一档兜底，而不是拦住整个操作 */
export function nearestPurchaseTaxRate(rate: number): number {
  return [...PURCHASE_TAX_RATES].sort((a, b) => Math.abs(a - rate) - Math.abs(b - rate))[0]
}

/**
 * 商品详情页 / 供应商档案上的 Vendor Tax 存的是**小数**(0 / 0.135 / 0.23)，采购单行存**百分数**
 * (0 / 13.5 / 23)。换算并对齐到三档；没设置返回 null。
 * ⛔ 20261013 修过的坑：采购建议转单把供应商的 0.23 直接当百分数写进采购单行，结果是 0.23% 而不是 23%。
 */
export function purchaseTaxRateFromVendorTax(vendorTax: unknown): number | null {
  if (vendorTax === null || vendorTax === undefined || vendorTax === '') return null
  const n = Number(vendorTax)
  if (!Number.isFinite(n)) return null
  return nearestPurchaseTaxRate(n * 100)
}

/**
 * 新采购行的默认税率(百分数)：商品自己的 Vendor Taxes 优先，没设再用供应商档案的，都没有为 0。
 * 新建/编辑采购单、复制历史单、采购建议转单都按这一个口径取，商品改了税率各处立刻跟着变。
 */
export function defaultPurchaseTaxRate(productVendorTax: unknown, supplierVendorTax?: unknown): number {
  return purchaseTaxRateFromVendorTax(productVendorTax) ?? purchaseTaxRateFromVendorTax(supplierVendorTax) ?? 0
}
