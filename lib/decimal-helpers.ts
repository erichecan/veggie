/**
 * Decimal ↔ number 边界工具
 * ============================================================================
 * 起因：Prisma 7 对 Decimal 字段返回 `Prisma.Decimal`（Decimal.js 实例），
 * 业务层习惯用 `number`。在两种形态交界处用本模块做正向/反向转换。
 *
 * 约定：
 *   - DB 返回 → 业务层：调用 toNum() 把 Decimal 变成 number（最多 2-4 位小数）
 *   - 业务层 → DB 写入：Prisma 会自动把 number 转成 Decimal，写入时无需处理
 *   - JSON 字段（如 Order.items）里存的是 number，不受本模块影响
 */

/**
 * 把 Prisma Decimal 或 number 变成 number。null/undefined 原样返回。
 */
export function toNum(value: unknown): number {
  if (value === null || value === undefined) return 0
  if (typeof value === 'number') return value
  if (typeof value === 'string') return Number(value)
  // Prisma.Decimal 实例有 toNumber()；兼容未定义的情况
  if (typeof value === 'object' && value !== null && 'toNumber' in value) {
    const fn = (value as { toNumber: () => number }).toNumber
    if (typeof fn === 'function') return fn.call(value)
  }
  return Number(value)
}

/**
 * 可选版：null/undefined 返回 undefined 而非 0
 */
export function toNumOpt(value: unknown): number | undefined {
  if (value === null || value === undefined) return undefined
  const n = toNum(value)
  return Number.isFinite(n) ? n : undefined
}

/** 四舍五入到 2 位小数（EUR 金额常用） */
export function round2(n: number): number {
  return Math.round(n * 100) / 100
}
