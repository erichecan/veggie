import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

const WAVE_TRACKED_FIELDS = ['status', 'orderIds', 'zones', 'driverName', 'waveType']

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const wave = await prisma.pickingWave.findUnique({ where: { id } })
    if (!wave) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(wave))
  } catch (error) {
    console.error('[GET /api/waves/[id]]', error)
    return NextResponse.json({ error: '获取波次失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const before = await prisma.pickingWave.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '波次不存在' }, { status: 404 })
      const wave = await prisma.pickingWave.update({
        where: { id },
        data: {
          ...data,
          status: data.status?.toUpperCase() ?? undefined,
        },
      })
      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        wave as unknown as Record<string, unknown>,
        WAVE_TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'picking-wave', resourceId: id,
        detail: `更新拣货波次: ${id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(wave))
    } catch (error) {
      console.error('[PUT /api/waves/[id]]', error)
      return NextResponse.json({ error: '更新波次失败' }, { status: 500 })
    }
  })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.pickingWave.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'picking-wave', resourceId: id,
        detail: `删除拣货波次: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/waves/[id]]', error)
      return NextResponse.json({ error: '删除波次失败' }, { status: 500 })
    }
  })
}
