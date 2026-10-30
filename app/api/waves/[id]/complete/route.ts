import { NextResponse } from 'next/server'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { prisma } from '@/lib/db'
import { completeWaveDelivery, describeFailures } from '@/lib/wave-complete'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const result = await completeWaveDelivery(id, { userId: user.userId, name: user.name })
      if (!result.ok) {
        if (result.reason === 'not-found') return NextResponse.json({ error: '波次不存在' }, { status: 404 })
        if (result.reason === 'not-dispatched') return NextResponse.json({ error: '该批次尚未出发' }, { status: 400 })
        return NextResponse.json({ error: '该批次已标记完成' }, { status: 400 })
      }
      const updated = await prisma.pickingWave.findUnique({ where: { id } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `标记完成：批次 ${result.waveName ?? id} 已完成配送，${result.completedIds.length} 张订单回填实送数量与状态（开票/提成等核销确认后生成）${result.tripIds.length ? `，行程 ${result.tripIds.length} 条置为完成` : ''}${describeFailures(result.failures)}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/complete]', error)
      return NextResponse.json({ error: '标记完成失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
