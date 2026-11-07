/** Shared print order for dispatch documents: driver, shift, pallet, then customer/order. */
export interface DispatchPrintableOrder {
  driverBatchLabel?: string | null
  customerName?: string | null
  code?: string | null
}

function parseDriverBatch(label: string | null | undefined) {
  const value = label?.trim() ?? ''
  const palletLabel = value.match(/^(\d+)\s+(am|pm)\s+(.+)$/i)
  if (palletLabel) {
    return {
      driver: palletLabel[3].trim(),
      shift: palletLabel[2].toLowerCase() === 'am' ? 0 : 1,
      batch: Number(palletLabel[1]),
      unassigned: false,
    }
  }

  return {
    driver: value,
    shift: 2,
    batch: Number.POSITIVE_INFINITY,
    unassigned: value.length === 0,
  }
}

export function compareDispatchPrintableOrders(a: DispatchPrintableOrder, b: DispatchPrintableOrder): number {
  const aGroup = parseDriverBatch(a.driverBatchLabel)
  const bGroup = parseDriverBatch(b.driverBatchLabel)

  if (aGroup.unassigned !== bGroup.unassigned) return aGroup.unassigned ? 1 : -1
  return aGroup.driver.localeCompare(bGroup.driver, undefined, { sensitivity: 'base' })
    || aGroup.shift - bGroup.shift
    || aGroup.batch - bGroup.batch
    || (a.customerName ?? '').localeCompare(b.customerName ?? '', undefined, { sensitivity: 'base' })
    || (a.code ?? '').localeCompare(b.code ?? '', undefined, { sensitivity: 'base' })
}
