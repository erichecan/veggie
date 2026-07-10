/** 报废原因：仓库报废(app/api/scrap)和客退处置(app/api/trips/[id]/returns)共用同一套原因口径 */
export const SCRAP_REASONS = [
  'CUSTOMER_RETURN_EXPIRED',
  'CUSTOMER_RETURN_DAMAGED',
  'WAREHOUSE_EXPIRY',
  'WAREHOUSE_DAMAGE',
  'OTHER',
] as const

export type ScrapReason = (typeof SCRAP_REASONS)[number]

export const SCRAP_REASON_LABEL: Record<string, string> = {
  CUSTOMER_RETURN_EXPIRED: '客退过期',
  CUSTOMER_RETURN_DAMAGED: '客退损坏',
  WAREHOUSE_EXPIRY: '仓库过期',
  WAREHOUSE_DAMAGE: '仓库损坏',
  OTHER: '其他',
}
