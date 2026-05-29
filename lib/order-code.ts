/**
 * 订单业务编号生成
 * 格式：<INITIALS>-YYMMDD-NNN
 *   - INITIALS：创建者 first name 首字母 + last name 首字母（大写），例：Charles Jiang → CJ
 *   - YYMMDD：订单创建当日（本地时区），例：260424
 *   - NNN：当天该缩写下的递增序号，从 001 开始，三位补零；超过 999 时位数自然变多
 *
 * 历史订单的 code 字段保持 NULL；显示时由 displayOrderCode() 兜底为 id 前 8 位。
 */
import type { PrismaClient } from '@/lib/generated/prisma/client'
import type * as Prisma from '@/lib/generated/prisma/internal/prismaNamespace'

/**
 * 从姓名中取大写首字母组合。
 * - "Charles Jiang"  → "CJ"
 * - "Hong Xia"       → "HX"
 * - "Xiaohui Weng(Evelyn)" → "XW"（取空格前的两段）
 * - "Edwin"          → "ED"（单个 token 时取前两个字母补齐）
 * - 含中文：取前两个字符大写化，例 "张敏" → "张敏"（保留原样，避免空字符）
 */
export function getInitials(rawName: string | null | undefined): string {
  const name = (rawName ?? '').trim()
  if (!name) return 'NA'
  // 去掉括号内容（"Xiaohui Weng(Evelyn)" → "Xiaohui Weng"）
  const cleaned = name.replace(/\(.*?\)/g, '').trim()
  // ASCII letters → 取空格分割的前两段首字母
  if (/^[A-Za-z][A-Za-z\s.'-]*$/.test(cleaned)) {
    const parts = cleaned.split(/\s+/).filter(Boolean)
    if (parts.length >= 2) {
      return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase()
    }
    // 单 token，例 "Edwin" → "ED"
    return cleaned.slice(0, 2).toUpperCase().padEnd(2, 'X')
  }
  // 含非 ASCII（中文等）：取前两个字符
  return cleaned.replace(/\s+/g, '').slice(0, 2).toUpperCase()
}

/** 把 Date 格式化为 YYMMDD（本地时区） */
export function formatYYMMDD(date: Date): string {
  const yy = String(date.getFullYear()).slice(-2)
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `${yy}${mm}${dd}`
}

/**
 * 计算下一序号。基于 code 前缀做 LIKE 查询（前缀已含日期，不会越查越大）。
 * 与唯一索引 + 重试组合使用即可保证并发安全。
 */
export async function nextOrderCode(
  client: PrismaClient | Prisma.TransactionClient,
  initials: string,
  date: Date,
): Promise<string> {
  const prefix = `${initials}-${formatYYMMDD(date)}-`
  const existing = await client.order.findMany({
    where: { code: { startsWith: prefix } },
    select: { code: true },
  })
  let maxSeq = 0
  for (const row of existing) {
    const m = row.code?.match(/-(\d+)$/)
    if (m) {
      const n = Number(m[1])
      if (n > maxSeq) maxSeq = n
    }
  }
  const seq = maxSeq + 1
  return `${prefix}${String(seq).padStart(3, '0')}`
}

/** 用于 UI 兜底显示，历史订单仍可读 */
export function displayOrderCode(o: { code?: string | null; id: string }): string {
  return o.code ?? `${o.id.slice(0, 8)}…`
}

/**
 * 生成下一个波次编号。格式：WAVE-YYMMDD-NNN
 * 与 nextOrderCode 相同的 LIKE + 递增逻辑，无唯一索引时通过调用方重试保证安全。
 */
export async function nextWaveCode(
  client: PrismaClient | Prisma.TransactionClient,
  date: Date,
): Promise<string> {
  const prefix = `WAVE-${formatYYMMDD(date)}-`
  const existing = await client.pickingWave.findMany({
    where: { name: { startsWith: prefix } },
    select: { name: true },
  })
  let maxSeq = 0
  for (const row of existing) {
    const m = row.name?.match(/-(\d+)$/)
    if (m) {
      const n = Number(m[1])
      if (n > maxSeq) maxSeq = n
    }
  }
  const seq = maxSeq + 1
  return `${prefix}${String(seq).padStart(3, '0')}`
}
