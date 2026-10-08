/**
 * 操作记录里哪些字段的值是「别的表的 id」(纯数据，无依赖；读日志时由 lib/action-log-refs.ts 换成名字)。
 * ⛔ diffChanges 新跟踪 xxxId / xxxIds 字段时必须在这里登记，tests/action-log-refs.test.ts 会检查。
 */
export type RefKind = 'pricelist' | 'user' | 'category' | 'partner' | 'uom' | 'driverSlot' | 'zone' | 'order' | 'wave'

/** changes 的 key → 它的值是哪张表的 id(单个或数组) */
export const REF_FIELDS: Record<string, RefKind> = {
  pricelistId: 'pricelist',
  pricelistIds: 'pricelist',
  basedOnPricelistId: 'pricelist',
  salesUserId: 'user',
  driverId: 'user',
  categoryId: 'category',
  restaurantId: 'partner',
  customerId: 'partner',
  supplierId: 'partner',
  partnerId: 'partner',
  uomId: 'uom',
  defaultDriverSlotId: 'driverSlot',
  driverSlotId: 'driverSlot',
  currentZoneId: 'zone',
  orderIds: 'order',
  waveId: 'wave',
}

/** 是 id 但没有可读名字可换的字段(显式登记，测试据此放行) */
export const REF_FIELDS_WITHOUT_NAME = new Set<string>()

