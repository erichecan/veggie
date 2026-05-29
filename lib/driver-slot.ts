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
