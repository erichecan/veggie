export interface DriverSlotInfo {
  id: string
  batchNum: number
  timeOfDay: string
  driverName: string
}

export function formatDriverSlot(slot: DriverSlotInfo | null | undefined): string {
  if (!slot) return ''
  return `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`
}

export function formatDriverSlotFromOrder(order: {
  driverSlot?: DriverSlotInfo | null
  deliveryBatch?: string | null
  deliveryBatchDisplay?: string | null
}): string {
  if (order.deliveryBatchDisplay) return order.deliveryBatchDisplay
  if (order.driverSlot) return formatDriverSlot(order.driverSlot)
  return order.deliveryBatch ?? ''
}

/**
 * 解析批次字符串 "2 pm AFZAAL" → { num: 2, time: 'pm', driver: 'AFZAAL' }。
 * 与 formatDriverSlot 互为逆操作；空串返回 { num: 0, time: '', driver: '' }。
 */
export function parseDriverSlotKey(key: string): { num: number; time: string; driver: string } {
  const parts = key.trim().split(/\s+/)
  return {
    num: parseInt(parts[0] ?? '0', 10) || 0,
    time: parts[1]?.toLowerCase() ?? '',
    driver: parts.slice(2).join(' '),
  }
}

/**
 * 从订单拿"司机姓名"（不含批次号/早晚班）。会计核销页按司机×业务日汇总收款用
 * 这个粒度——同一司机同天跑早班+午班是常见场景（见 PickingWave 唯一性设计），
 * 但会计只跟人对一次账，不按批次拆开对。空字符串代表这单还没分配司机。
 */
export function driverNameFromOrder(order: {
  driverSlot?: DriverSlotInfo | null
  deliveryBatch?: string | null
  deliveryBatchDisplay?: string | null
}): string {
  return parseDriverSlotKey(formatDriverSlotFromOrder(order)).driver
}
