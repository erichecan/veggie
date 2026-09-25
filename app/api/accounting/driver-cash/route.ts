import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { round2 } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { attachWaveDisplay } from '@/lib/wave-assign'
import { driverNameFromOrder } from '@/lib/driver-slot'
import { businessDayRange, toDayKey } from '@/lib/analytics/metrics'

/**
 * 会计核销页「钱」板块的取数入口——按司机汇总某个业务日的应收（现金/转账），
 * 附带这个司机这一天有没有被会计确认过。金额来自今天实际送出去的订单，
 * 不依赖司机自己申报——这正是这次改造要去掉的那层（见 DEV-PLAN 20260924）。
 */
export const ACTIVE_STATUSES = ['CONFIRMED', 'WAVE_ASSIGNED', 'IN_DELIVERY', 'COMPLETED'] as const

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const dateParam = searchParams.get('date')
      const at = dateParam ? new Date(`${dateParam}T00:00:00`) : new Date()
      if (isNaN(at.getTime())) {
        return NextResponse.json({ error: 'date 格式无效' }, { status: 400 })
      }
      const { start, end } = businessDayRange(at)
      const businessDate = toDayKey(start)

      const orders = await prisma.order.findMany({
        where: {
          status: { in: [...ACTIVE_STATUSES] },
          deliveryDate: { gte: start, lt: end },
        },
        select: {
          id: true,
          paymentMethod: true,
          driverSlot: { select: { id: true, batchNum: true, timeOfDay: true, driverName: true } },
          lines: { select: { subtotal: true, taxRate: true } },
        },
      })

      const withDriver = await attachWaveDisplay(serializeApi(orders))

      const groups = new Map<string, { cashTotal: number; transferTotal: number; orderIds: string[] }>()
      for (const o of withDriver) {
        const driverName = driverNameFromOrder(o)
        if (!driverName) continue
        const amount = orderIncTaxTotal(o.lines ?? [])
        const g = groups.get(driverName) ?? { cashTotal: 0, transferTotal: 0, orderIds: [] as string[] }
        if (String(o.paymentMethod).toUpperCase() === 'CASH') g.cashTotal += amount
        else g.transferTotal += amount
        g.orderIds.push(o.id)
        groups.set(driverName, g)
      }

      const confirmations = groups.size > 0
        ? await prisma.driverCashConfirmation.findMany({
            where: { businessDate, driverName: { in: [...groups.keys()] } },
          })
        : []
      const confirmedByDriver = new Map(confirmations.map(c => [c.driverName, c]))

      const drivers = [...groups.entries()]
        .map(([driverName, g]) => {
          const c = confirmedByDriver.get(driverName)
          return {
            driverName,
            cashTotal: round2(g.cashTotal),
            transferTotal: round2(g.transferTotal),
            total: round2(g.cashTotal + g.transferTotal),
            orderCount: g.orderIds.length,
            confirmed: !!c,
            confirmedAt: c?.confirmedAt ?? null,
            confirmedByName: c?.confirmedByName ?? null,
          }
        })
        .sort((a, b) => a.driverName.localeCompare(b.driverName, 'zh-CN'))

      return NextResponse.json(serializeApi({ businessDate, drivers }))
    } catch (error) {
      console.error('[GET /api/accounting/driver-cash]', error)
      return NextResponse.json({ error: '获取司机收款汇总失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
