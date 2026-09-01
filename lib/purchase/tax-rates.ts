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
