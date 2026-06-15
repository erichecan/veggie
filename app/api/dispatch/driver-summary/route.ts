import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

type OrderItemRaw = { quantity: number }

/** GET ?date=YYYY-MM-DD：司机调度汇总——每个司机批次当天送几家/几单/几件/金额/状态。 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const dateStr = searchParams.get('date')
      if (!dateStr) return NextResponse.json({ error: '缺少 date 参数' }, { status: 400 })

      const day = new Date(`${dateStr}T00:00:00.000Z`)
      const next = new Date(day)
      next.setUTCDate(day.getUTCDate() + 1)

      const waves = await prisma.pickingWave.findMany({
        where: { waveDate: { gte: day, lt: next } },
      })
      if (waves.length === 0) return NextResponse.json({ date: dateStr, rows: [] })

      const slotIds = Array.from(
        new Set(waves.map(w => w.driverSlotId).filter(Boolean) as string[]),
      )
      const slots = slotIds.length
        ? await prisma.driverSlot.findMany({
            where: { id: { in: slotIds } },
            select: { id: true, timeOfDay: true, batchNum: true, driverName: true },
          })
        : []
      const slotMap = new Map(slots.map(s => [s.id, s]))

      const allOrderIds = Array.from(new Set(waves.flatMap(w => (w.orderIds as string[]) ?? [])))
      const orders = allOrderIds.length
        ? await prisma.order.findMany({
            where: { id: { in: allOrderIds } },
            select: { id: true, restaurantName: true, items: true, totalAmount: true },
          })
        : []
      const orderMap = new Map(orders.map(o => [o.id, o]))

      const rows = waves.map(w => {
        const ids = (w.orderIds as string[]) ?? []
        const restaurants = new Set<string>()
        let totalQty = 0
        let totalAmount = 0
        for (const oid of ids) {
          const o = orderMap.get(oid)
          if (!o) continue
          restaurants.add(o.restaurantName)
          totalAmount += Number(o.totalAmount ?? 0)
          for (const it of (o.items as OrderItemRaw[]) ?? []) totalQty += it.quantity
        }
        const slot = w.driverSlotId ? slotMap.get(w.driverSlotId) : null
        return {
          waveId: w.id,
          driverName: w.driverName ?? slot?.driverName ?? '',
          timeOfDay: slot?.timeOfDay ?? null,
          batchNum: slot?.batchNum ?? w.waveNumber ?? null,
          restaurantCount: restaurants.size,
          orderCount: ids.length,
          totalQty: Math.round(totalQty * 1000) / 1000,
          totalAmount: Math.round(totalAmount * 100) / 100,
          status: w.status,
        }
      })

      rows.sort(
        (a, b) =>
          (a.timeOfDay ?? '').localeCompare(b.timeOfDay ?? '') ||
          (a.batchNum ?? 0) - (b.batchNum ?? 0),
      )

      const totals = rows.reduce(
        (acc, r) => ({
          restaurantCount: acc.restaurantCount + r.restaurantCount,
          orderCount: acc.orderCount + r.orderCount,
          totalQty: acc.totalQty + r.totalQty,
          totalAmount: Math.round((acc.totalAmount + r.totalAmount) * 100) / 100,
        }),
        { restaurantCount: 0, orderCount: 0, totalQty: 0, totalAmount: 0 },
      )

      return NextResponse.json({ date: dateStr, rows, totals })
    } catch (error) {
      console.error('[GET /api/dispatch/driver-summary]', error)
      return NextResponse.json({ error: '获取司机汇总失败' }, { status: 500 })
    }
  })
}
