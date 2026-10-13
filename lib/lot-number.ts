/**
 * 批次号 LOT-00001 的发号 —— 20261013
 * ============================================================================
 * 以前是 `LOT-${lot.count() + 1}`：批次号唯一，而手动建批次可以自定义名字(/api/lots 的 lotName)、
 * 导入/脚本也会建批次，只要现有编号不是从 1 连续排下来，count+1 就会撞上已有的号，
 * 「确认收货」整个事务 P2002 回滚，界面只看到 "Server temporarily unavailable"(客户 PO-00053 收货失败)。
 * 改为取现有 LOT-数字 里的最大号往后排；一次要多个号(一张采购单多行)就连续给。
 */
import { nextSequenceNumber } from './sequence-number'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function nextLotNumbers(client: any, count: number): Promise<string[]> {
  if (count <= 0) return []
  const start = await nextSequenceNumber(client, 'Lot', 'LOT-')
  return Array.from({ length: count }, (_, i) => `LOT-${String(start + i).padStart(5, '0')}`)
}
