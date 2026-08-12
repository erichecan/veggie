/**
 * 供应商结算口径（台账 G2）
 * ============================================================================
 * 验收三条：能生成对账单并显示应付余额 / 一张账单多次付款且余额正确递减 /
 * 账龄分析数字与明细一致。
 *
 * 这一层只放纯函数：单笔付款怎么落到余额上、账龄怎么分桶、明细与汇总怎么核对。
 * 接口、页面、校验脚本共用同一份 —— 应付这块最怕的就是「页面显示一个数、
 * 账龄报表另一个数」，而那必然来自两处各算一遍。
 */

import { round2 } from '@/lib/decimal-helpers'

export const VENDOR_PAYMENT_METHODS = ['bank', 'cash', 'other'] as const
export type VendorPaymentMethod = (typeof VENDOR_PAYMENT_METHODS)[number]

export const VENDOR_PAYMENT_METHOD_LABELS: Record<VendorPaymentMethod, { zh: string; en: string }> = {
  bank: { zh: '银行转账', en: 'Bank transfer' },
  cash: { zh: '现金', en: 'Cash' },
  other: { zh: '其他', en: 'Other' },
}

export interface ApplyPaymentInput {
  totalIncTax: number
  /** 本笔之前的累计已付（由流水汇总而来，不是账单上那个字段） */
  paidSoFar: number
  /** 本笔金额 */
  amount: number
}

export interface ApplyPaymentResult {
  newPaid: number
  newDue: number
  fullyPaid: boolean
  error?: string
}

/**
 * 一笔付款落到账单上的结果。
 *
 * 超付**拒绝**而不是截断：多付的钱要么是录错、要么是预付款，两种都得人来判断。
 * 截断成刚好付清会让「我明明付了 €500」和账上的 €480 永远对不上，且没有任何痕迹。
 */
export function applyVendorPayment({ totalIncTax, paidSoFar, amount }: ApplyPaymentInput): ApplyPaymentResult {
  const total = round2(totalIncTax)
  const before = round2(paidSoFar)
  const amt = round2(amount)
  if (!(amt > 0)) {
    return { newPaid: before, newDue: round2(total - before), fullyPaid: false, error: '付款金额必须大于 0' }
  }
  const newPaid = round2(before + amt)
  if (newPaid > total + 0.005) {
    return {
      newPaid: before, newDue: round2(total - before), fullyPaid: false,
      error: `付款超额：已付 €${before.toFixed(2)} + 本笔 €${amt.toFixed(2)} > 账单总额 €${total.toFixed(2)}`,
    }
  }
  const newDue = round2(total - newPaid)
  return { newPaid, newDue: Math.max(0, newDue), fullyPaid: newDue <= 0.005 }
}

// ── 账龄 ────────────────────────────────────────────────────────────────────

export type AgingBucket = 'current' | 'd1_30' | 'd31_60' | 'd61_90' | 'd90_plus' | 'unknown'

/**
 * 账龄分桶。与 /api/analytics/ap-aging 的 SQL **同一套阈值** ——
 * 这个函数存在的意义就是让校验脚本能在 JS 侧独立算一遍去对 SQL 的结果；
 * 若两边都用同一段 SQL，"账龄与明细一致"这条验收就是自己验自己。
 */
export function agingBucketOf(dueDate: Date | string | null | undefined, today: Date): AgingBucket {
  if (!dueDate) return 'unknown'
  const d = new Date(dueDate)
  if (isNaN(d.getTime())) return 'unknown'
  const days = Math.floor((Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate())
    - Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate())) / 86400000)
  if (days <= 0) return 'current'
  if (days <= 30) return 'd1_30'
  if (days <= 60) return 'd31_60'
  if (days <= 90) return 'd61_90'
  return 'd90_plus'
}

export interface OpenBillRow {
  supplierId: string
  amountDue: number
  dueDate: Date | string | null
}

/** 按供应商 × 桶汇总未结账单 —— 校验脚本据此与接口返回逐格比对 */
export function summarizeAging(bills: OpenBillRow[], today: Date): Map<string, number> {
  const out = new Map<string, number>()
  for (const b of bills) {
    const key = `${b.supplierId}|${agingBucketOf(b.dueDate, today)}`
    out.set(key, round2((out.get(key) ?? 0) + round2(b.amountDue)))
  }
  return out
}
