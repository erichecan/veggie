/**
 * 库位常量（20261014 复式改造 L3）。迁移 20261014000002 按这些 id 建好 StockLocation，代码直接引用。
 * 单独成文件是为了 stock-ledger ↔ stock-valuation 不互相循环引用。
 */
export const LOC = {
  STOCK: 'loc_wh_stock',
  VENDORS: 'loc_partner_vendors',
  CUSTOMERS: 'loc_partner_customers',
  INVENTORY: 'loc_virtual_inventory',
  SCRAP: 'loc_virtual_scrap',
  OPENING: 'loc_virtual_opening',
} as const
export type LocationId = typeof LOC[keyof typeof LOC]

/** 内部库位（实物在我们仓里）。目前只有一个仓；以后加子库位/多仓，在这里登记 */
export const INTERNAL_LOCATIONS: ReadonlySet<string> = new Set([LOC.STOCK])

export const LOCATION_LABEL: Record<string, { zh: string; en: string }> = {
  [LOC.STOCK]: { zh: '仓库/库存', en: 'WH/Stock' },
  [LOC.VENDORS]: { zh: '供应商', en: 'Partners/Vendors' },
  [LOC.CUSTOMERS]: { zh: '客户', en: 'Partners/Customers' },
  [LOC.INVENTORY]: { zh: '盘点调整', en: 'Virtual/Inventory adjustment' },
  [LOC.SCRAP]: { zh: '报废', en: 'Virtual/Scrap' },
  [LOC.OPENING]: { zh: '期初', en: 'Virtual/Opening balance' },
}
