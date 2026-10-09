/**
 * 订单业务编号生成（报价单/销售订单共用同一条 Order 记录的同一个号）
 * 格式：D-YYMMDD-NNN，例：D-260424-001
 *   - D：固定前缀，20261008 起统一改为 D 开头（此前是创建者缩写，如 CJ，按人不同而不同）
 *   - YYMMDD：订单创建当日（本地时区），例：260424
 *   - NNN：当天的递增序号，从 001 开始，三位补零；超过 999 时位数自然变多
 *
 * 历史订单的 code 字段保持原有的 <INITIALS>-YYMMDD-NNN 格式不回填，不影响既往单据。
 * 历史订单的 code 字段也可能保持 NULL；显示时由 displayOrderCode() 兜底为 id 前 8 位。
 */
import type { PrismaClient } from '@/lib/generated/prisma/client'
import type * as Prisma from '@/lib/generated/prisma/internal/prismaNamespace'

const ORDER_CODE_PREFIX = 'D'

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
  date: Date,
): Promise<string> {
  const prefix = `${ORDER_CODE_PREFIX}-${formatYYMMDD(date)}-`
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
