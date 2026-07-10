/**
 * 金额格式化工具函数
 * 统一格式：两位小数，不加千分位分隔符（如 "123.45"、"€123.45"）
 * 全站唯一 SSOT——其余文件里各自重复实现的 fmtMoney/eur/fmt 均应改为从这里 import。
 */

function toNum(v: unknown): number {
  if (v == null) return 0
  const n = typeof v === 'number' ? v : Number(v)
  return Number.isFinite(n) ? n : 0
}

/** "123.45"，不带货币符号 */
export function fmtMoney(v: unknown): string {
  return toNum(v).toFixed(2)
}

/** "€123.45" */
export function eur(v: unknown): string {
  return `€${toNum(v).toFixed(2)}`
}
