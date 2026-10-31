/** A wave is a driver/time dispatch; the numbered delivery batches are its pallets. */
export function deliveryAssignmentLabel(input: {
  driverName?: string | null
  timeOfDay?: string | null
  batchNums: readonly number[]
}): string {
  const driver = input.driverName?.trim() || '未指定司机'
  const time = input.timeOfDay?.trim().toUpperCase()
  const assignment = [driver, time].filter(Boolean).join(' ')
  const batches = [...new Set(input.batchNums)].sort((a, b) => a - b)
  return batches.length > 0
    ? `${assignment} 配送批次 ${batches.map(n => `#${n}`).join('、')}`
    : `${assignment}（未分配托盘批次）`
}
