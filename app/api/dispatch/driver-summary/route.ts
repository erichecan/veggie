import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'

type OrderItemRaw = { quantity: number }

/** GET ?date=YYYY-MM-DD：司机调度汇总——每个司机批次当天送几家/几单/几件/金额/状态。 */
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      // 支持日期范围 ?from=&to=（兼容旧的 ?date=单日）
      const fromStr = searchParams.get('from') ?? searchParams.get('date')
      const toStr = searchParams.get('to') ?? searchParams.get('date') ?? fromStr
      if (!fromStr) return NextResponse.json({ error: '缺少 from/date 参数' }, { status: 400 })

      const from = new Date(`${fromStr}T00:00:00.000Z`)
      const toBase = new Date(`${toStr}T00:00:00.000Z`)
      const to = new Date(toBase)
      to.setUTCDate(toBase.getUTCDate() + 1)

      const emptyTotals = { restaurantCount: 0, orderCount: 0, totalQty: 0, totalAmount: 0 }

      // include pallets：批次号(batchNum)现在是波次内部的托盘编号，一个波次可能横跨多个托盘，
      // 不能再用 driverSlotId 反查单个 DriverSlot 拿一个批次号(会漏掉波次里其余托盘，见
      // daily-sales/PrintCenter.tsx 2026-07-10 的同类复盘)。
      const waves = await prisma.pickingWave.findMany({
        where: { waveDate: { gte: from, lt: to } },
        include: { pallets: { select: { seq: true } } },
      })
      if (waves.length === 0) return NextResponse.json({ from: fromStr, to: toStr, rows: [], totals: emptyTotals })

      // legacy 兜底：极少数历史波次 driverName 快照字段为空，用 driverSlotId 反查补一次司机姓名——
      // 仅用于司机姓名兜底，不再用于 batchNum/timeOfDay(那两个已经是 wave 自身的权威字段)。
      const legacySlotIds = Array.from(
        new Set(waves.filter(w => !w.driverName && w.driverSlotId).map(w => w.driverSlotId) as string[]),
      )
      const legacySlots = legacySlotIds.length
        ? await prisma.driverSlot.findMany({
            where: { id: { in: legacySlotIds } },
            select: { id: true, driverName: true },
          })
        : []
      const legacySlotMap = new Map(legacySlots.map(s => [s.id, s]))

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
        const wd = w.waveDate ? new Date(w.waveDate) : null
        const batchNums = [...new Set(w.pallets.map(p => p.seq))].sort((a, b) => a - b)
        return {
          waveId: w.id,
          driverName: w.driverName ?? (w.driverSlotId ? legacySlotMap.get(w.driverSlotId)?.driverName : undefined) ?? '',
          timeOfDay: w.timeOfDay ?? null,
          batchNums,
          restaurantCount: restaurants.size,
          orderCount: ids.length,
          totalQty: Math.round(totalQty * 1000) / 1000,
          totalAmount: Math.round(totalAmount * 100) / 100,
          status: w.status,
          waveDate: wd ? wd.toISOString().slice(0, 10) : null,
          weekday: wd ? wd.getUTCDay() : null,
        }
      })

      rows.sort(
        (a, b) =>
          (a.timeOfDay ?? '').localeCompare(b.timeOfDay ?? '') ||
          (a.batchNums[0] ?? 0) - (b.batchNums[0] ?? 0),
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

      return NextResponse.json({ from: fromStr, to: toStr, rows, totals })
    } catch (error) {
      console.error('[GET /api/dispatch/driver-summary]', error)
      return NextResponse.json({ error: '获取司机汇总失败' }, { status: 500 })
    }
  })
}
