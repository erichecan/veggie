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

/**
 * 订单维度的拣货锁校验：订单只要落在任一「已锁定」波次里，就禁止改其内容/明细。
 * 锁定的语义是「拣货作业进行中，不许再动这张单」——不仅不许换车(归属)，也不许改量(内容)。
 * 用于订单编辑/加行/改量/删行等写接口，与 assertWaveNotPickLocked(改归属) 形成完整闭环。
 */
export async function assertOrderNotPickLocked(orderId: string): Promise<void> {
  const wave = await prisma.pickingWave.findFirst({
    where: { orderIds: { has: orderId }, pickLockedAt: { not: null } },
    select: { id: true },
  })
  if (wave) throw new WavePickLockedError(wave.id)
}
