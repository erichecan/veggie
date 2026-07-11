import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const slots = await prisma.driverSlot.findMany({
        where: { archived: false },
        orderBy: [{ timeOfDay: 'asc' }, { batchNum: 'asc' }],
      })

      // First try: customers with explicit defaultDriverSlotId
      let customers = await prisma.customer.findMany({
        where: {
          isCustomer: true,
          defaultDriverSlotId: { not: null },
        },
        select: {
          id: true,
          name: true,
          latitude: true,
          longitude: true,
          street: true,
          street2: true,
          city: true,
          zip: true,
          country: true,
          defaultDriverSlotId: true,
        },
      })

      // Fallback: derive from order history (most frequent driverSlotId per restaurant)
      if (customers.length === 0) {
        const orderStats = await prisma.order.groupBy({
          by: ['restaurantId', 'driverSlotId'],
          where: { driverSlotId: { not: null } },
          _count: { id: true },
          orderBy: { _count: { id: 'desc' } },
        })

        // Pick most frequent slot per restaurant
        const restaurantSlotMap = new Map<string, string>()
        for (const stat of orderStats) {
          if (!stat.driverSlotId) continue
          if (!restaurantSlotMap.has(stat.restaurantId)) {
            restaurantSlotMap.set(stat.restaurantId, stat.driverSlotId)
          }
        }

        if (restaurantSlotMap.size > 0) {
          const restaurantIds = Array.from(restaurantSlotMap.keys())
          const rawCustomers = await prisma.customer.findMany({
            where: { id: { in: restaurantIds }, isCustomer: true },
            select: {
              id: true,
              name: true,
              latitude: true,
              longitude: true,
              street: true,
              street2: true,
              city: true,
              zip: true,
              country: true,
            },
          })

          customers = rawCustomers.map(c => ({
            ...c,
            defaultDriverSlotId: restaurantSlotMap.get(c.id) ?? null,
          }))
        }
      }

      // 路线按「司机+时段」聚合，不再按单个 DriverSlot(=托盘)分别算——一个司机一个时段
      // 现在只有一辆车、一条连续路线，托盘 1/3/4 的客户混在同一趟车里，分开算路线会把
      // 一趟车的真实里程/耗时切成互不相关的几段，工作量(轻/中/重)判断系统性失真
      // (见 2026-07-10 复盘：BAO 一个上午被拆成 3 条"独立路线")。
      type SlotGroup = { driverName: string; timeOfDay: string; slotIds: string[] }
      const groups = new Map<string, SlotGroup>()
      for (const slot of slots) {
        const key = `${slot.driverName}__${slot.timeOfDay}`
        const g = groups.get(key) ?? { driverName: slot.driverName, timeOfDay: slot.timeOfDay, slotIds: [] }
        g.slotIds.push(slot.id)
        groups.set(key, g)
      }

      const sortedGroups = [...groups.values()].sort(
        (a, b) => a.timeOfDay.localeCompare(b.timeOfDay) || a.driverName.localeCompare(b.driverName),
      )

      const batches = sortedGroups.map((g, idx) => {
        const groupCustomers = customers.filter(
          c => c.defaultDriverSlotId && g.slotIds.includes(c.defaultDriverSlotId),
        )
        const label = `${g.timeOfDay} ${g.driverName}`
        return {
          batchLabel: label,
          batchIndex: idx,
          driverSlotIds: g.slotIds,
          restaurants: groupCustomers.map(c => serializeApi({
            id: c.id,
            name: c.name,
            latitude: c.latitude,
            longitude: c.longitude,
            address: [c.street, c.street2, c.city, c.zip, c.country].filter(Boolean).join(', '),
          })),
        }
      }).filter(b => b.restaurants.length > 0)

      return NextResponse.json(batches)
    } catch (error) {
      console.error('[GET /api/batch-analysis]', error)
      return NextResponse.json({ error: '加载批次分析失败' }, { status: 500 })
    }
  })
}
