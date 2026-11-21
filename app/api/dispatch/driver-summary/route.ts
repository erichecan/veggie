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

      // 调度页显示默认车牌：优先按波次绑定的 DriverSlot → User 身份取默认车辆，
      // 早期缺少 driverSlotId 的波次再按司机名回退。未出发波次跟随当前车辆配置；
      // 已出发波次仍显示保存的车牌快照，确保历史配送不被主数据变更改写。
      const driverSlotIds = Array.from(new Set(waves.map(w => w.driverSlotId).filter((id): id is string => !!id)))
      const driverNames = Array.from(new Set(waves.map(w => w.driverName).filter((name): name is string => !!name)))
      const driverSlots = driverSlotIds.length || driverNames.length
        ? await prisma.driverSlot.findMany({
            where: { OR: [
              ...(driverSlotIds.length ? [{ id: { in: driverSlotIds } }] : []),
              ...(driverNames.length ? [{ driverName: { in: driverNames } }] : []),
            ] },
            select: {
              id: true, driverName: true, timeOfDay: true,
              driverUser: { select: { id: true, defaultFleetVehicle: { select: { id: true, plate: true, isActive: true } } } },
            },
          })
        : []
      const driverSlotMap = new Map(driverSlots.map(s => [s.id, s]))
      const driverNameSlotMap = new Map(driverSlots.map(s => [s.driverName, s]))
      const unboundDriverNames = [...new Set(driverSlots.filter(s => !s.driverUser).map(s => s.driverName))]
      const fallbackDrivers = unboundDriverNames.length
        ? await prisma.user.findMany({
            where: {
              name: { in: unboundDriverNames },
              isActive: true,
              OR: [{ role: 'DRIVER' }, { roles: { has: 'DRIVER' } }],
            },
            select: { id: true, name: true, defaultFleetVehicle: { select: { id: true, plate: true, isActive: true } } },
          })
        : []
      const fallbackDriverMap = new Map(fallbackDrivers.map(driver => [driver.name, driver]))

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
        const slot = (w.driverSlotId ? driverSlotMap.get(w.driverSlotId) : undefined)
          ?? (w.driverName ? driverNameSlotMap.get(w.driverName) : undefined)
        const configuredVehicle = slot?.driverUser?.defaultFleetVehicle
          ?? (slot ? fallbackDriverMap.get(slot.driverName)?.defaultFleetVehicle : undefined)
        const driverUserId = slot?.driverUser?.id
          ?? (slot ? fallbackDriverMap.get(slot.driverName)?.id : undefined)
        const defaultPlate = configuredVehicle?.isActive ? configuredVehicle.plate : null
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
          vehiclePlate: w.dispatchedAt || w.completedAt ? w.vehiclePlate : (defaultPlate ?? w.vehiclePlate),
          defaultVehicleId: configuredVehicle?.id ?? null,
          driverUserId: driverUserId ?? null,
          driverName: w.driverName || slot?.driverName || '',
          timeOfDay: w.timeOfDay || slot?.timeOfDay || null,
          batchNums,
          restaurantCount: restaurants.size,
          orderCount: ids.length,
          totalQty: Math.round(totalQty * 1000) / 1000,
          totalAmount: Math.round(totalAmount * 100) / 100,
          // PickingWave.status 只记录拣货/分货阶段，出发和完成分别存时间戳；汇总页展示
          // 当前配送生命周期，不能让已出发/已完成的旧波次继续显示为初始 PENDING。
          status: w.completedAt ? 'COMPLETED' : w.dispatchedAt ? 'IN_DELIVERY' : w.status,
          waveDate: wd ? wd.toISOString().slice(0, 10) : null,
          weekday: wd ? wd.getUTCDay() : null,
        }
      })

      rows.sort(
        (a, b) =>
          (a.timeOfDay ?? '').localeCompare(b.timeOfDay ?? '') ||
          (a.batchNums[0] ?? 0) - (b.batchNums[0] ?? 0) ||
          a.driverName.localeCompare(b.driverName) ||
          a.waveId.localeCompare(b.waveId),
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
