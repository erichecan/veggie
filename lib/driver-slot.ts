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
}): string {
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
