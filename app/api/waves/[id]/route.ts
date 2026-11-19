import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth, userHasPermission } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

const WAVE_TRACKED_FIELDS = ['status', 'orderIds', 'zones', 'driverName', 'waveType', 'vehiclePlate']

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const wave = await prisma.pickingWave.findUnique({ where: { id }, include: { pallets: { select: { seq: true } } } })
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
      if (data.status !== undefined && (before.dispatchedAt || before.completedAt)) {
        return NextResponse.json({ error: '波次已出发，不能再修改拣货/分货状态' }, { status: 409 })
      }
      if (data.vehiclePlate !== undefined) {
        if (!userHasPermission(user, 'dispatch.wave.update')) return NextResponse.json({ error: '只有配送调度可以安排车辆' }, { status: 403 })
        if (before.dispatchedAt || before.completedAt) return NextResponse.json({ error: '已出发的车牌快照不可修改，请在出发前设置' }, { status: 409 })
        const plate = String(data.vehiclePlate ?? '').trim().toUpperCase()
        if (plate.length > 24 || (plate && !/^[A-Z0-9 -]+$/.test(plate))) return NextResponse.json({ error: '车牌只能包含字母、数字、空格和短横线，最多 24 字符' }, { status: 400 })
        data.vehiclePlate = plate || null
      }
      // SSOT: orderIds 成员变更只能走 assign/unassign（会原子同步 Order.status）。
      // 通用 PUT 剥掉 orderIds，防止绕过状态同步造成两套真相不一致。
      const { orderIds: _ignoredOrderIds, ...safeData } = data
      const wave = await prisma.pickingWave.update({
        where: { id },
        data: {
          ...safeData,
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
  }, { require: ['dispatch.wave.update', 'stock.quality.manage'] })
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
  }, { require: 'dispatch.wave.delete' })
}
