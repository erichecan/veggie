import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * P1-10: 司机交账确认
 *
 * GET  /api/trips/:id/settlement  — 查看交账详情
 * POST /api/trips/:id/settlement  — 司机提交交账
 * PUT  /api/trips/:id/settlement  — 财务确认交账
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      const trip = await prisma.trip.findUnique({
        where: { id },
        select: {
          id: true,
          name: true,
          driverId: true,
          driverName: true,
          status: true,
          totalPayment: true,
          driverCommission: true,
          cashCollected: true,
          onlineCollected: true,
          settlementStatus: true,
          settledAt: true,
          settledBy: true,
          settlementNote: true,
          restaurants: true,
        },
      })

      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      // 计算应收总额和已收总额
      const cashCollected = trip.cashCollected?.toNumber() ?? 0
      const onlineCollected = trip.onlineCollected?.toNumber() ?? 0
      const totalCollected = cashCollected + onlineCollected
      const totalPayment = trip.totalPayment.toNumber()
      const difference = totalCollected - totalPayment

      return NextResponse.json(serializeApi({
        ...trip,
        totalCollected,
        difference,
      }))
    } catch (error) {
      console.error('[GET /api/trips/[id]/settlement]', error)
      return NextResponse.json({ error: '获取交账详情失败' }, { status: 500 })
    }
  }, ['DRIVER', 'FINANCE', 'OPERATOR', 'BOSS'])
}

/**
 * POST — 司机提交交账
 *
 * 请求体：
 *   { cashCollected, onlineCollected, settlementNote? }
 *
 * 前提：行程状态必须为 COMPLETED，交账状态为 pending
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      if (trip.status !== 'COMPLETED') {
        return NextResponse.json(
          { error: '只有 COMPLETED 状态的行程才能提交交账' },
          { status: 400 },
        )
      }

      if (trip.settlementStatus !== 'pending') {
        return NextResponse.json(
          { error: `交账已提交（当前状态: ${trip.settlementStatus}）` },
          { status: 400 },
        )
      }

      const { cashCollected, onlineCollected, settlementNote } = body

      if (cashCollected === undefined || onlineCollected === undefined) {
        return NextResponse.json(
          { error: '缺少必填字段: cashCollected, onlineCollected' },
          { status: 400 },
        )
      }

      const updated = await prisma.trip.update({
        where: { id },
        data: {
          cashCollected,
          onlineCollected,
          settlementNote: settlementNote ?? null,
          settlementStatus: 'submitted',
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `司机提交交账: 现金${cashCollected} 在线${onlineCollected}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/trips/[id]/settlement]', error)
      return NextResponse.json({ error: '提交交账失败' }, { status: 500 })
    }
  }, ['DRIVER', 'OPERATOR', 'BOSS'])
}

/**
 * PUT — 财务确认交账
 *
 * 请求体：
 *   { confirmed: true, settlementNote? }
 *   或 { confirmed: false, settlementNote: "退回原因" }  — 退回重新提交
 *
 * 前提：交账状态为 submitted
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      if (trip.settlementStatus !== 'submitted') {
        return NextResponse.json(
          { error: `只有 submitted 状态的交账才能确认（当前: ${trip.settlementStatus}）` },
          { status: 400 },
        )
      }

      const { confirmed, settlementNote } = body

      if (confirmed === undefined) {
        return NextResponse.json({ error: '缺少 confirmed 字段' }, { status: 400 })
      }

      const updateData: Record<string, unknown> = {}

      if (confirmed) {
        updateData.settlementStatus = 'confirmed'
        updateData.settledAt = new Date()
        updateData.settledBy = user.userId
        if (settlementNote) updateData.settlementNote = settlementNote
      } else {
        // 退回：重置为 pending，司机需重新提交
        updateData.settlementStatus = 'pending'
        updateData.settlementNote = settlementNote ?? '财务退回，请重新提交'
      }

      const updated = await prisma.trip.update({
        where: { id },
        data: updateData,
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: confirmed
          ? `财务确认交账: 行程 ${trip.name}`
          : `财务退回交账: ${settlementNote ?? ''}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/trips/[id]/settlement]', error)
      return NextResponse.json({ error: '确认交账失败' }, { status: 500 })
    }
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}
