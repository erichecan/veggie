/**
 * 缺货原因（台账 D6）
 * ============================================================================
 * 需求要「每次操作写入缺货原因并可追溯」。原因用**代码 + 自由备注**两段：
 *   · 代码是有限集合，将来才可能按原因归因统计（供应商缺货 vs 自家损耗是两回事）；
 *   · 备注是自由文本，因为现实里的解释永远超出任何枚举。
 *
 * 落地方式刻意不新建表：原因跟着已有的两条审计轨迹走 ——
 *   · `ActionLog.detail`：缺货 tab 的「操作记录」面板本来就在读它，追加一句即可显示；
 *   · `OrderAuditLog.changedFields`：订单详情的 chatter 读它，客户来问「为什么少送」时
 *     在那张单上就能看到原因，不用去翻别处。
 * 新建一张 ShortageReason 表只会多出第三处真相，而这两处本来就必须写。
 */

export const SHORTAGE_REASON_CODES = [
  'SUPPLIER_SHORT',
  'QUALITY',
  'DAMAGED',
  'STOCK_MISMATCH',
  'SUBSTITUTED',
  'OTHER',
] as const

export type ShortageReasonCode = (typeof SHORTAGE_REASON_CODES)[number]

export const SHORTAGE_REASON_LABELS: Record<ShortageReasonCode, { zh: string; en: string }> = {
  SUPPLIER_SHORT: { zh: '供应商缺货', en: 'Supplier short' },
  QUALITY: { zh: '质量不合格', en: 'Quality rejected' },
  DAMAGED: { zh: '破损', en: 'Damaged' },
  STOCK_MISMATCH: { zh: '账实不符', en: 'Stock mismatch' },
  SUBSTITUTED: { zh: '已用替代品', en: 'Substituted' },
  OTHER: { zh: '其他', en: 'Other' },
}

export interface ShortageReasonInput {
  reasonCode?: unknown
  reasonNote?: unknown
}

export function isShortageReasonCode(v: unknown): v is ShortageReasonCode {
  return typeof v === 'string' && (SHORTAGE_REASON_CODES as readonly string[]).includes(v)
}

export function parseShortageReason(input: ShortageReasonInput | null | undefined): {
  code: ShortageReasonCode | null
  note: string
} {
  const code = isShortageReasonCode(input?.reasonCode) ? input.reasonCode : null
  const raw = typeof input?.reasonNote === 'string' ? input.reasonNote.trim() : ''
  return { code, note: raw.slice(0, 200) }
}

/**
 * 追加到 ActionLog.detail 末尾的一句话。没有原因就返回空串 —— 不写「原因：无」，
 * 那会让「这条没填原因」和「这条填了『无』」看起来一样。
 */
export function formatShortageReason(input: ShortageReasonInput | null | undefined): string {
  const { code, note } = parseShortageReason(input)
  if (!code && !note) return ''
  const label = code ? SHORTAGE_REASON_LABELS[code].zh : '其他'
  return note ? ` · 原因：${label}（${note}）` : ` · 原因：${label}`
}
