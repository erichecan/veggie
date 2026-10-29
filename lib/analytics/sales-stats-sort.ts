/**
 * 日销售管理中心「销售统计 · 按客户」的列排序（20261028 客户需求：加订单号 / 批次 / 司机 /
 * AM-PM 列，并能按列排序）。纯函数，屏幕表格专用；单测见 tests/sales-stats-sort.test.ts。
 */

/** 可排序的列。默认（未选排序键）时屏幕按 日期 → 客户 分组，不走这里 */
export type CustomerSortKey = 'product' | 'order' | 'batch' | 'driver' | 'time' | 'qty' | 'amount'

export interface SortableLine {
  customerName: string
  productName: string
  orderCode: string
  /** 0 = 未分配批次 */
  batchNum: number
  /** 'am' / 'pm' / ''（未分配） */
  timeOfDay: string
  driverName: string
  qty: number
  amount: number
}

/** am 在 pm 前，未分配（空串）在最后 */
const timeRank = (t: string) => (t === 'am' ? 0 : t === 'pm' ? 1 : 2)

function compareBy(a: SortableLine, b: SortableLine, key: CustomerSortKey): number {
  switch (key) {
    case 'product': return a.productName.localeCompare(b.productName)
    case 'order': return a.orderCode.localeCompare(b.orderCode, undefined, { numeric: true })
    // 批次号相同再按 AM/PM、司机——「#1 AM」与「#1 PM」是两车货
    case 'batch': return a.batchNum - b.batchNum || timeRank(a.timeOfDay) - timeRank(b.timeOfDay) || a.driverName.localeCompare(b.driverName)
    case 'driver': return a.driverName.localeCompare(b.driverName) || timeRank(a.timeOfDay) - timeRank(b.timeOfDay) || a.batchNum - b.batchNum
    case 'time': return timeRank(a.timeOfDay) - timeRank(b.timeOfDay) || a.batchNum - b.batchNum || a.driverName.localeCompare(b.driverName)
    case 'qty': return a.qty - b.qty
    case 'amount': return a.amount - b.amount
  }
}

/** 该列「没有值」的行（无订单号 / 未分配批次或司机）——升降序都垫底，不会因为降序跑到最前 */
function isBlank(l: SortableLine, key: CustomerSortKey): boolean {
  if (key === 'order') return !l.orderCode
  if (key === 'batch') return l.batchNum === 0
  if (key === 'driver') return !l.driverName
  if (key === 'time') return !l.timeOfDay
  return false
}

export function sortCustomerLines<T extends SortableLine>(lines: readonly T[], key: CustomerSortKey, dir: 'asc' | 'desc'): T[] {
  const sign = dir === 'asc' ? 1 : -1
  return [...lines].sort((a, b) => {
    const blankA = isBlank(a, key), blankB = isBlank(b, key)
    if (blankA !== blankB) return blankA ? 1 : -1
    return sign * compareBy(a, b, key)
      // 同值时稳定兜底：客户 → 订单号 → 商品，跟默认分组视图的阅读顺序一致
      || a.customerName.localeCompare(b.customerName)
      || a.orderCode.localeCompare(b.orderCode, undefined, { numeric: true })
      || a.productName.localeCompare(b.productName)
  })
}
