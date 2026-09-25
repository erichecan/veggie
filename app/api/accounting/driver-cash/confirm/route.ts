import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { driverNameFromOrder } from '@/lib/driver-slot'
import { businessDayRange, toDayKey } from '@/lib/analytics/metrics'
import { postCollections, driverCashConfirmationMarker } from '@/lib/trip-settlement-payment'
import { ACTIVE_STATUSES } from '../route'

/**
 * 会计核了一遍这个司机今天的现金/转账没问题，点「确认」——**真正入账**：
 * 生成 Payment、核销到发票上。不可撤销，写错了要走人工冲正，这里不提供反向操作
 * （见 DEV-PLAN 20260924 风险点 1）。金额由服务端重新计算，不信任客户端传的数字。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => ({}))
      const { driverName, businessDate: businessDateInput } = body as {
        driverName?: string
        businessDate?: string
      }
      if (!driverName || !businessDateInput) {
        return NextResponse.json({ error: '缺少 driverName 或 businessDate' }, { status: 400 })
      }

      const at = new Date(`${businessDateInput}T00:00:00`)
      if (isNaN(at.getTime())) {
        return NextResponse.json({ error: 'businessDate 格式无效' }, { status: 400 })
      }
      const { start, end } = businessDayRange(at)
      const businessDate = toDayKey(start)

      const existing = await prisma.driverCashConfirmation.findUnique({
        where: { driverName_businessDate: { driverName, businessDate } },
      })
      if (existing) {
        return NextResponse.json({ error: '这个司机这一天已经确认过了，不能重复确认' }, { status: 409 })
      }

      const orders = await prisma.order.findMany({
        where: {
          status: { in: [...ACTIVE_STATUSES] },
          deliveryDate: { gte: start, lt: end },
        },
        select: {
          id: true,
          restaurantId: true,
          restaurantName: true,
          paymentMethod: true,
          driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
          lines: { select: { subtotal: true, taxRate: true } },
        },
      })
      const withDriver = await attachWaveDisplay(serializeApi(orders))
      const mine = withDriver.filter(o => driverNameFromOrder(o) === driverName)
      if (mine.length === 0) {
        return NextResponse.json({ error: '这个司机今天没有订单，没什么可确认的' }, { status: 400 })
      }

      // 按客户分组，拼成 postCollections 需要的 shape（每个客户一"站"）
      const byCustomer = new Map<string, { restaurantId: string; restaurantName: string; payment: number; orderIds: string[] }>()
      let cashTotal = 0
      let transferTotal = 0
      for (const o of mine) {
        const amount = orderIncTaxTotal(o.lines ?? [])
        if (String(o.paymentMethod).toUpperCase() === 'CASH') cashTotal += amount
        else transferTotal += amount
        const key = o.restaurantId
        const g = byCustomer.get(key) ?? {
          restaurantId: o.restaurantId, restaurantName: o.restaurantName ?? '', payment: 0, orderIds: [] as string[],
        }
        g.payment = round2(g.payment + amount)
        g.orderIds.push(o.id)
        byCustomer.set(key, g)
      }

      const actorName = user.name ?? user.email ?? user.userId
      const confirmation = await prisma.driverCashConfirmation.create({
        data: {
          driverName,
          businessDate,
          cashTotal: round2(cashTotal),
          transferTotal: round2(transferTotal),
          orderIds: mine.map(o => o.id),
          paymentIds: [],
          confirmedById: user.userId,
          confirmedByName: actorName,
        },
      })

      const marker = driverCashConfirmationMarker(confirmation.id)
      const posting = await postCollections(
        prisma,
        { marker, restaurants: [...byCustomer.values()] },
        actorName,
      )

      if (posting.paymentIds.length > 0) {
        await prisma.driverCashConfirmation.update({
          where: { id: confirmation.id },
          data: { paymentIds: posting.paymentIds },
        })
      }

      return NextResponse.json(serializeApi({
        confirmation,
        posting,
      }))
    } catch (error) {
      console.error('[POST /api/accounting/driver-cash/confirm]', error)
      return NextResponse.json({ error: '确认失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.confirm' })
}
