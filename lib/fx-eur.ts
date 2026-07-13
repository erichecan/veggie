/**
 * 采购单汇率折算 SSOT —— 原币金额 × PurchaseOrder.exchangeRate → 欧元折算值。
 * 汇率未知(exchangeRatePending)时传 null，返回 null，调用方据此跳过下游写入而不是拿一个
 * 猜测出来的数字悄悄记账（见 20260713 汇率换算改造）。
 */
export function eurAmount(raw: unknown, exchangeRate: number | null | undefined, decimals = 2): number | null {
  if (exchangeRate == null) return null
  const rate = Number(exchangeRate)
  if (!Number.isFinite(rate) || rate <= 0) return null
  const value = Number(raw)
  if (!Number.isFinite(value)) return null
  const factor = Math.pow(10, decimals)
  return Math.round(value * rate * factor) / factor
}

/**
 * 欧元恒为 1；非欧元有有效汇率就用，没有也不阻断（exchangeRate=null、pending=true），
 * 由调用方决定何时挡住(见 purchase-orders PATCH action=confirm)。
 */
export function resolveExchangeRate(
  currency: string,
  rawRate: number | null | undefined,
): { exchangeRate: number | null; exchangeRatePending: boolean } {
  if (currency.toUpperCase() === 'EUR') return { exchangeRate: 1, exchangeRatePending: false }
  const rate = rawRate == null ? NaN : Number(rawRate)
  if (Number.isFinite(rate) && rate > 0) return { exchangeRate: rate, exchangeRatePending: false }
  return { exchangeRate: null, exchangeRatePending: true }
}
