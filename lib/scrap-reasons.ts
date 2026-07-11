/** 报废原因：仓库报废(app/api/scrap)和客退处置(app/api/trips/[id]/returns)共用同一套原因口径 */
export const SCRAP_REASONS = [
  'CUSTOMER_RETURN_EXPIRED',
  'CUSTOMER_RETURN_DAMAGED',
  'WAREHOUSE_EXPIRY',
  'WAREHOUSE_DAMAGE',
  'RECEIPT_DAMAGE',
  'OTHER',
] as const

export type ScrapReason = (typeof SCRAP_REASONS)[number]

export const SCRAP_REASON_LABEL: Record<string, string> = {
  CUSTOMER_RETURN_EXPIRED: '客退过期',
  CUSTOMER_RETURN_DAMAGED: '客退损坏',
  WAREHOUSE_EXPIRY: '仓库过期',
  WAREHOUSE_DAMAGE: '仓库损坏',
  RECEIPT_DAMAGE: '到货即损坏（运输/供应商责任）',
  OTHER: '其他',
}

export const SCRAP_REASON_LABEL_EN: Record<string, string> = {
  CUSTOMER_RETURN_EXPIRED: 'Customer return — expired',
  CUSTOMER_RETURN_DAMAGED: 'Customer return — damaged',
  WAREHOUSE_EXPIRY: 'Warehouse — expired',
  WAREHOUSE_DAMAGE: 'Warehouse — damaged',
  RECEIPT_DAMAGE: 'Damaged on arrival (carrier/supplier fault)',
  OTHER: 'Other',
}
