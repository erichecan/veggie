import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import type { OrderItem, TripRestaurant } from '@/lib/types'

// GET /api/trips — 行程列表，可选 driverId / waveId / status / settlementStatus 过滤
export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const driverId = searchParams.get('driverId')
      const waveId = searchParams.get('waveId')
      const status = searchParams.get('status')
      const settlementStatus = searchParams.get('settlementStatus')
      const trips = await prisma.trip.findMany({
        where: {
          ...(driverId ? { driverId } : {}),
          ...(waveId ? { waveId } : {}),
          ...(status ? { status: status.toUpperCase() as never } : {}),
          ...(settlementStatus ? { settlementStatus } : {}),
        },
        orderBy: { createdAt: 'desc' },
      })
      return NextResponse.json(serializeApi(trips))
    } catch (error) {
      console.error('[GET /api/trips]', error)
      return NextResponse.json({ error: '获取行程失败' }, { status: 500 })
    }
  })
}

// POST /api/trips — 手动创建行程
// Body: { timeSlot: 'AM'|'PM', deliveryBatch?: string, driverId?: string, orderIds: string[], departTime?: string }
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      // ── 新流程：通过 orderIds 手动创建行程 ──────────────────────────────
      if (Array.isArray(data.orderIds) && data.orderIds.length > 0) {
        const { timeSlot, driverId, deliveryBatch: rawDeliveryBatch, driverSlotId, orderIds, departTime, waveId } = data as {
          timeSlot: string
          driverId?: string
          deliveryBatch?: string
          driverSlotId?: string
          orderIds: string[]
          departTime?: string
          waveId?: string
        }
        let deliveryBatch = rawDeliveryBatch

        if (!timeSlot || !['AM', 'PM'].includes(timeSlot)) {
          return NextResponse.json({ error: '请选择配送时段（AM / PM）' }, { status: 400 })
        }
        if (!driverId && !deliveryBatch && !driverSlotId) {
          return NextResponse.json({ error: '请选择配送批次' }, { status: 400 })
        }

        // 解析司机信息（优先用 driverId；否则从 driverSlotId / deliveryBatch 提取司机名）
        let tripDriverId: string | null = null
        let tripDriverName: string | null = null
        let driverName: string | undefined

        if (driverSlotId) {
          const slot = await prisma.driverSlot.findUnique({ where: { id: driverSlotId } })
          if (slot) {
            driverName = slot.driverName
            if (!deliveryBatch) deliveryBatch = `${slot.batchNum} ${slot.timeOfDay} ${slot.driverName}`
          }
        }

        if (driverId) {
          const driver = await prisma.user.findUnique({
            where: { id: driverId },
            select: { id: true, name: true, role: true },
          })
          if (!driver || driver.role !== 'DRIVER') {
            return NextResponse.json({ error: '司机不存在或角色不匹配' }, { status: 400 })
          }
          tripDriverId = driver.id
          tripDriverName = driver.name
        } else if (deliveryBatch) {
          // "1 pm AFZAAL" → driver name is everything after the second space
          const parts = deliveryBatch.split(' ')
          tripDriverName = parts.slice(2).join(' ') || deliveryBatch
        }

        // 查订单
        const orders = await prisma.order.findMany({
          where: { id: { in: orderIds } },
        })
        if (orders.length === 0) {
          return NextResponse.json({ error: '所选订单不存在' }, { status: 400 })
        }

        // 按餐馆分组，构建 TripRestaurant[]
        const grouped = new Map<string, { restaurantId: string; restaurantName: string; orderIds: string[]; items: OrderItem[] }>()
        for (const order of orders) {
          const entry = grouped.get(order.restaurantId) ?? {
            restaurantId: order.restaurantId,
            restaurantName: order.restaurantName,
            orderIds: [],
            items: [],
          }
          entry.orderIds.push(order.id)
          const orderItems = order.items as unknown as OrderItem[]
          entry.items.push(...orderItems)
          grouped.set(order.restaurantId, entry)
        }

        // 查餐馆地址
        const restaurantIds = Array.from(grouped.keys())
        const customers = await prisma.customer.findMany({
          where: { id: { in: restaurantIds } },
          select: { id: true, address: true, street: true, street2: true, city: true, zip: true },
        })
        const addressMap = new Map(customers.map(c => {
          const parts = [c.street, c.street2, c.city, c.zip].filter(Boolean)
          return [c.id, parts.length > 0 ? parts.join(', ') : c.address]
        }))

        const restaurants: TripRestaurant[] = Array.from(grouped.values()).map(g => ({
          ...g,
          address: addressMap.get(g.restaurantId) ?? '',
          delivered: false,
          returns: [],
          pods: [],
          cargoVerified: false,
        }))

        const restaurantCount = restaurants.length
        const tripName = deliveryBatch
          ? `${deliveryBatch} · ${restaurantCount}家餐馆`
          : `${timeSlot === 'AM' ? '上午' : '下午'} · ${tripDriverName} · ${restaurantCount}家餐馆`

        // 事务：创建 Trip + 更新订单状态
        const trip = await prisma.$transaction(async (tx) => {
          const created = await tx.trip.create({
            data: {
              timeSlot,
              name: tripName,
              waveId: waveId ?? null,
              driverId: tripDriverId,
              driverName: tripDriverName,
              departTime: departTime ?? null,
              status: 'PENDING',
              restaurants: restaurants as never,
            },
          })
          await tx.order.updateMany({
            where: { id: { in: orderIds } },
            data: { status: 'IN_DELIVERY' },
          })
          return created
        })

        await writeLog({
          userId: user.userId, userEmail: user.email, userName: user.name,
          action: 'CREATE', resource: 'trip', resourceId: trip.id,
          detail: `手动创建行程「${tripName}」，含 ${restaurantCount} 家餐馆，${orders.length} 个订单`,
        })

        return NextResponse.json(serializeApi(trip), { status: 201 })
      }

      // ── 旧流程：直接传入完整行程数据（兼容旧代码） ───────────────────────
      const trip = await prisma.trip.create({
        data: {
          ...data,
          status: data.status?.toUpperCase() ?? 'PENDING',
          restaurants: data.restaurants ?? [],
        },
      })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'trip', resourceId: trip.id,
        detail: `创建行程: ${trip.id}`,
      })
      return NextResponse.json(serializeApi(trip), { status: 201 })
    } catch (error) {
      console.error('[POST /api/trips]', error)
      return NextResponse.json({ error: '创建行程失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.create' })
}
