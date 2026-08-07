import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const wave = await prisma.pickingWave.findUnique({ where: { id } })
      if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      if (!wave.dispatchedAt) return NextResponse.json({ error: '该批次尚未出发' }, { status: 400 })
      if (wave.completedAt) return NextResponse.json({ error: '该批次已标记完成' }, { status: 400 })

      const updated = await prisma.pickingWave.update({
        where: { id },
        data: { completedAt: new Date() },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `标记完成：批次 ${wave.name ?? id} 已完成配送`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/waves/[id]/complete]', error)
      return NextResponse.json({ error: '标记完成失败' }, { status: 500 })
    }
  }, { require: 'dispatch.wave.update' })
}
