import { prisma } from '@/lib/db'

/**
 * 已出发波次保护：确认出发(dispatchedAt)后，波次的订单归属不可再变——
 * unassign/moveWave(调度台拖拽)、assign 的"顺手从其他波次摘除"、assignOrderToWave
 * 的同名逻辑，均需先过此闸。completedAt 恒隐含 dispatchedAt 已置(见 waveStage)，
 * 故只需判断 dispatchedAt 一列即覆盖"已出发"与"已完成"两个阶段。
 *
 * 例外：lib/wave-assign.ts 的 removeOrderFromAllWaves 不接此闸——它被订单撤回/取消
 * 复用，IN_DELIVERY→CANCELLED 是状态机允许的合法流转，发车后取消订单需要能把它从
 * 波次摘出去，这里加闸会把合法的取消流程堵死。
 */
export class WaveDispatchedError extends Error {
  waveId: string
  constructor(waveId: string) {
    super('该批次已出发，不能再分配')
    this.name = 'WaveDispatchedError'
    this.waveId = waveId
  }
}

export async function assertWaveNotDispatched(waveId: string): Promise<void> {
  const wave = await prisma.pickingWave.findUnique({
    where: { id: waveId },
    select: { dispatchedAt: true },
  })
  if (wave?.dispatchedAt) throw new WaveDispatchedError(waveId)
}
