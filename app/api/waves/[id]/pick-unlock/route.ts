import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * POST /api/waves/[id]/pick-unlock
 * 解除拣货锁定：调度改完后，打印员重打拣货单会再次上锁（POST pick-lock）。
 * 仅 BOSS / WAREHOUSE 可操作——本次不做「申请解锁」审批流，调度口头找打印员即可。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({
        where: { id },
        select: { id: true, name: true, pickLockedAt: true },
      })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (!wave.pickLockedAt) return NextResponse.json({ error: '该批次未锁定' }, { status: 400 })

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { pickLockedAt: null, pickLockedBy: null, pickUnlockedAt: new Date() },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `解锁批次 ${wave.name ?? id}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/waves/[id]/pick-unlock]', error)
      return NextResponse.json({ error: '解锁批次失败' }, { status: 500 })
    }
  }, ['BOSS', 'WAREHOUSE'])
}
