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

      const batches = slots.map((slot, idx) => {
        const slotCustomers = customers.filter(c => c.defaultDriverSlotId === slot.id)
        const label = `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`
        return {
          batchLabel: label,
          batchIndex: idx,
          driverSlotId: slot.id,
          restaurants: slotCustomers.map(c => serializeApi({
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
