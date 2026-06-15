/** 数量求和后消除 JS 浮点累加误差（8.501999999999999 → 8.502），最多保留 3 位小数 */
export const roundQty = (n: number) => Math.round(n * 1000) / 1000
export const fmtQty = (n: number) => String(roundQty(n))
