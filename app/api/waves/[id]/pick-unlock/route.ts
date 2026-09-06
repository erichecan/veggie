import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { removeOrderFromPalletsInWave } from '@/lib/wave-assign'

/**
 * POST /api/waves/[id]/pick-unlock
 *
 * 20260906 客户拍板改语义（推翻 docs/prd/20260703-分配打印锁定闭环-prd.md 里"解锁只是临时
 * 开锁给调度微调，改完重打重新上锁"的原设计）：解锁 = 取消这一整波司机安排，订单退回待分配池。
 * 客户点了"解锁"就是要把这批司机安排整个撤掉，不是要一个"锁开关"。
 *
 * 与 unassign 路由（部分订单移出波次）同一套回退口径：orderIds 清空、WAVE_ASSIGNED→CONFIRMED
 * （IN_DELIVERY/COMPLETED 不动，理论上不会出现——已出发波次不会还带着 pickLockedAt）、
 * 托盘残留一并清理，三步在同一事务提交，避免"订单已不在 orderIds、行数据却卡在 Pallet.items"
 * 的孤儿态（2026-09-05 生产事故同款坑，见 lib/wave-assign.ts 顶部注释）。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({
        where: { id },
        select: { id: true, name: true, pickLockedAt: true, orderIds: true },
      })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (!wave.pickLockedAt) return NextResponse.json({ error: '该批次未锁定' }, { status: 400 })

      const orderIds = wave.orderIds as string[]

      const updated = await prisma.$transaction(async (tx) => {
        const w = await tx.pickingWave.update({
          where: { id },
          data: {
            pickLockedAt: null, pickLockedBy: null, pickUnlockedAt: new Date(),
            orderIds: [], zones: [], assignmentDoneAt: null,
          },
        })
        if (orderIds.length > 0) {
          await tx.order.updateMany({
            where: { id: { in: orderIds }, status: 'WAVE_ASSIGNED' },
            data: { status: 'CONFIRMED' },
          })
          for (const orderId of orderIds) {
            await removeOrderFromPalletsInWave(id, orderId, tx)
          }
        }
        return w
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `解锁批次 ${wave.name ?? id}，取消司机安排，${orderIds.length} 个订单退回待分配`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/waves/[id]/pick-unlock]', error)
      return NextResponse.json({ error: '解锁批次失败' }, { status: 500 })
    }
  }, { require: 'stock.pick.manage' })
}
