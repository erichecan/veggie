import { prisma } from '@/lib/db'

/**
 * 拣货锁定：打印员打印拣货单后回填 PickingWave.pickLockedAt，期间调度不可改该批次
 * 的订单归属（assign/unassign/批次内移动/销售单改司机/撤销分配完成）。
 * 确认出发与缺货改量（打印员操作）不受此锁影响。见 docs/prd/20260703-分配打印锁定闭环-prd.md。
 */
export class WavePickLockedError extends Error {
  waveId: string
  constructor(waveId: string) {
    super('该批次拣货中已锁定，请找打印员解锁')
    this.name = 'WavePickLockedError'
    this.waveId = waveId
  }
}

export async function assertWaveNotPickLocked(waveId: string): Promise<void> {
  const wave = await prisma.pickingWave.findUnique({
    where: { id: waveId },
    select: { pickLockedAt: true },
  })
  if (wave?.pickLockedAt) throw new WavePickLockedError(waveId)
}
