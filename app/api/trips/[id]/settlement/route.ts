import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import type { TripRestaurant } from '@/lib/types'
import { postTripCollections, type SettlementPostingResult } from '@/lib/trip-settlement-payment'

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

      // 司机提成明细：每单读冻结快照 driverCommissionTotal（不实时重算），供结算页分项展示
      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
      const orderIds = restaurants.flatMap(r => r.orderIds ?? [])
      const commissionOrders = orderIds.length > 0
        ? await prisma.order.findMany({
            where: { id: { in: orderIds } },
            select: { id: true, code: true, restaurantName: true, driverCommissionTotal: true, commissionFrozenAt: true },
          })
        : []
      const commissionTotal = commissionOrders.reduce((s, o) => s + (o.driverCommissionTotal?.toNumber() ?? 0), 0)

      return NextResponse.json(serializeApi({
        ...trip,
        totalCollected,
        difference,
        commissionOrders,
        commissionTotal,
      }))
    } catch (error) {
      console.error('[GET /api/trips/[id]/settlement]', error)
      return NextResponse.json({ error: '获取交账详情失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
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
  }, { require: 'finance.settlement.create' })
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

      // ── 确认交账 = 真正入账 ────────────────────────────────────────────────
      // 此前这里只翻转 settlementStatus，钱收了账上看不出来（生产库 Invoice 148285 张、
      // Payment 0 条）。现在把各站实收核销到对应发票上。
      // 不自动过账 DRAFT 发票——过账是财务动作，不该是交账确认的副作用。
      let settlementResult: SettlementPostingResult | null = null
      if (confirmed) {
        // ⚠️ 传人名而不是 userId：`Payment.createdBy` 是给人看的「经手人」，
        // /api/payments 手工登记那条路径写的就是 user.name。这里原先写 userId，
        // 同一列两条路径两种语义 —— 对账单明细上一行显示「张三」、一行显示
        // 一串 cuid，浏览器实测当场看见（台账 G1）。
        settlementResult = await postTripCollections(prisma, trip, user.name ?? user.email ?? user.userId)
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: confirmed
          ? `财务确认交账: 行程 ${trip.name}`
          : `财务退回交账: ${settlementNote ?? ''}`,
      })

      return NextResponse.json(serializeApi({ ...updated, settlementPosting: settlementResult }))
    } catch (error) {
      console.error('[PUT /api/trips/[id]/settlement]', error)
      return NextResponse.json({ error: '确认交账失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.confirm' })
}
