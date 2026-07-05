import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { freezeTripCommission } from '@/lib/commission'
import type { TripRestaurant, OrderItem } from '@/lib/types'

/**
 * P1-7: 核货确认（Cargo Verification）
 *
 * 司机装车前逐项核对数量，记录 verifiedQty 到 Trip.restaurants JSON。
 * 当 verifiedQty ≠ orderedQty 时自动标记差异（供 P1-8 差异处理使用）。
 *
 * POST /api/trips/:id/verify
 *   {
 *     restaurantId: string,
 *     items: [{ productId, verifiedQty }]
 *   }
 *
 * GET /api/trips/:id/verify — 查看核货状态
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const trip = await prisma.trip.findUnique({
      where: { id },
      select: { id: true, name: true, status: true, restaurants: true },
    })
    if (!trip) {
      return NextResponse.json({ error: '行程不存在' }, { status: 404 })
    }

    const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
    const summary = restaurants.map(r => ({
      restaurantId: r.restaurantId,
      restaurantName: r.restaurantName,
      cargoVerified: r.cargoVerified,
      itemCount: r.items?.length ?? 0,
      discrepancies: (r.items ?? []).filter(
        (it: OrderItem & { verifiedQty?: number }) =>
          it.verifiedQty !== undefined && it.verifiedQty !== it.quantity,
      ).length,
    }))

    const allVerified = restaurants.length > 0 && restaurants.every(r => r.cargoVerified)

    return NextResponse.json(serializeApi({
      tripId: trip.id,
      tripName: trip.name,
      tripStatus: trip.status,
      allVerified,
      restaurants: summary,
    }))
  } catch (error) {
    console.error('[GET /api/trips/[id]/verify]', error)
    return NextResponse.json({ error: '获取核货状态失败' }, { status: 500 })
  }
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { restaurantId, items } = body as {
        restaurantId: string
        items: Array<{ productId: string; verifiedQty: number }>
      }

      if (!restaurantId || !Array.isArray(items) || items.length === 0) {
        return NextResponse.json(
          { error: '缺少必填字段: restaurantId, items[]' },
          { status: 400 },
        )
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      // 只允许在 PENDING / PENDING_ASSIGNMENT / VERIFYING 状态下核货
      const allowedStatuses = ['PENDING', 'PENDING_ASSIGNMENT', 'VERIFYING']
      if (!allowedStatuses.includes(String(trip.status))) {
        return NextResponse.json(
          { error: `当前状态 ${trip.status} 不允许核货操作` },
          { status: 400 },
        )
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
      const rIdx = restaurants.findIndex(r => r.restaurantId === restaurantId)
      if (rIdx === -1) {
        return NextResponse.json(
          { error: `行程中未找到客户 ${restaurantId}` },
          { status: 404 },
        )
      }

      const restaurant = restaurants[rIdx]

      // 用 verifiedQty map 快速查找
      const verifyMap = new Map(items.map(it => [it.productId, it.verifiedQty]))

      // 更新每个 item 的 verifiedQty
      const discrepancies: Array<{
        productId: string
        productName: string
        orderedQty: number
        verifiedQty: number
        diff: number
      }> = []

      const updatedItems = (restaurant.items ?? []).map((item: OrderItem) => {
        const vQty = verifyMap.get(item.productId)
        const verifiedQty = vQty !== undefined ? vQty : item.quantity // 未提交的默认=订购量

        if (verifiedQty !== item.quantity) {
          discrepancies.push({
            productId: item.productId,
            productName: item.productName,
            orderedQty: item.quantity,
            verifiedQty,
            diff: verifiedQty - item.quantity,
          })
        }

        return { ...item, verifiedQty }
      })

      // 更新 restaurant
      restaurants[rIdx] = {
        ...restaurant,
        items: updatedItems,
        cargoVerified: true,
      }

      // 如果所有餐馆都已核货，自动推进行程状态到 VERIFYING → IN_PROGRESS
      const allVerified = restaurants.every(r => r.cargoVerified)
      const newStatus = allVerified && String(trip.status) !== 'IN_PROGRESS'
        ? 'IN_PROGRESS'
        : (String(trip.status) === 'PENDING' ? 'VERIFYING' : undefined)

      const updated = await prisma.$transaction(async (tx) => {
        const trip = await tx.trip.update({
          where: { id },
          data: {
            restaurants: restaurants as never,
            ...(newStatus ? { status: newStatus } : {}),
          },
        })

        await freezeTripCommission(id, tx)

        return trip
      })

      const discrepancyNote = discrepancies.length > 0
        ? ` (${discrepancies.length}项差异)`
        : ''
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `核货确认: ${restaurant.restaurantName}${discrepancyNote}`,
      })

      return NextResponse.json(serializeApi({
        trip: updated,
        verification: {
          restaurantId,
          restaurantName: restaurant.restaurantName,
          cargoVerified: true,
          allVerified,
          discrepancies,
        },
      }))
    } catch (error) {
      console.error('[POST /api/trips/[id]/verify]', error)
      return NextResponse.json({ error: '核货确认失败' }, { status: 500 })
    }
  }, ['DRIVER', 'OPERATOR', 'BOSS', 'WAREHOUSE'])
}
