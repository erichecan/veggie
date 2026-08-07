import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import type { TripRestaurant, OrderItem } from '@/lib/types'

/**
 * P1-8: 差异处理流程
 *
 * 核货确认后（P1-7）verifiedQty ≠ orderedQty 的行自动成为差异记录。
 * 管理层可以：
 *   - accept: 以 verifiedQty 为准，调整 OrderLine.deliveredQty
 *   - reject: 恢复为 orderedQty，要求仓库补货
 *
 * GET  /api/trips/:id/discrepancy — 列出所有差异
 * PUT  /api/trips/:id/discrepancy — 批量处理差异
 */

interface DiscrepancyItem {
  restaurantId: string
  restaurantName: string
  productId: string
  productName: string
  orderedQty: number
  verifiedQty: number
  diff: number
  resolved?: boolean
  resolution?: 'accept' | 'reject'
}

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
    const discrepancies: DiscrepancyItem[] = []

    for (const r of restaurants) {
      if (!r.cargoVerified) continue
      for (const item of (r.items ?? []) as Array<OrderItem & { verifiedQty?: number; discrepancyResolved?: boolean; discrepancyResolution?: string }>) {
        if (item.verifiedQty !== undefined && item.verifiedQty !== item.quantity) {
          discrepancies.push({
            restaurantId: r.restaurantId,
            restaurantName: r.restaurantName,
            productId: item.productId,
            productName: item.productName,
            orderedQty: item.quantity,
            verifiedQty: item.verifiedQty,
            diff: item.verifiedQty - item.quantity,
            resolved: item.discrepancyResolved ?? false,
            resolution: item.discrepancyResolution as 'accept' | 'reject' | undefined,
          })
        }
      }
    }

    return NextResponse.json(serializeApi({
      tripId: trip.id,
      tripName: trip.name,
      totalDiscrepancies: discrepancies.length,
      unresolvedCount: discrepancies.filter(d => !d.resolved).length,
      discrepancies,
    }))
  } catch (error) {
    console.error('[GET /api/trips/[id]/discrepancy]', error)
    return NextResponse.json({ error: '获取差异列表失败' }, { status: 500 })
  }
}

/**
 * PUT — 批量处理差异
 *
 * 请求体:
 *   {
 *     resolutions: [
 *       { restaurantId, productId, action: 'accept' | 'reject', note?: string }
 *     ]
 *   }
 *
 * accept: deliveredQty = verifiedQty（确认差异合理）
 * reject: deliveredQty = orderedQty（要求仓库补货，差异不影响交付量）
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { resolutions } = body as {
        resolutions: Array<{
          restaurantId: string
          productId: string
          action: 'accept' | 'reject'
          note?: string
        }>
      }

      if (!Array.isArray(resolutions) || resolutions.length === 0) {
        return NextResponse.json({ error: '缺少 resolutions[]' }, { status: 400 })
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]

      // 收集需要更新 OrderLine.deliveredQty 的记录
      const orderLineUpdates: Array<{
        orderId: string
        productId: string
        deliveredQty: number
      }> = []

      let acceptCount = 0
      let rejectCount = 0

      for (const res of resolutions) {
        const rIdx = restaurants.findIndex(r => r.restaurantId === res.restaurantId)
        if (rIdx === -1) continue

        const restaurant = restaurants[rIdx]
        const items = restaurant.items as Array<OrderItem & {
          verifiedQty?: number
          discrepancyResolved?: boolean
          discrepancyResolution?: string
          discrepancyNote?: string
        }>

        const itemIdx = items.findIndex(it => it.productId === res.productId)
        if (itemIdx === -1) continue

        const item = items[itemIdx]
        if (item.verifiedQty === undefined || item.verifiedQty === item.quantity) continue

        // Mark as resolved in JSON
        items[itemIdx] = {
          ...item,
          discrepancyResolved: true,
          discrepancyResolution: res.action,
          discrepancyNote: res.note,
        }

        const finalQty = res.action === 'accept' ? item.verifiedQty : item.quantity

        if (res.action === 'accept') acceptCount++
        else rejectCount++

        // Queue OrderLine update for each order this restaurant has
        for (const orderId of restaurant.orderIds) {
          orderLineUpdates.push({
            orderId,
            productId: item.productId,
            deliveredQty: finalQty,
          })
        }

        restaurants[rIdx] = { ...restaurant, items }
      }

      // Transaction: update Trip JSON + OrderLine.deliveredQty
      await prisma.$transaction(async (tx) => {
        await tx.trip.update({
          where: { id },
          data: { restaurants: restaurants as never },
        })

        // Update OrderLine deliveredQty for accepted/rejected items
        for (const upd of orderLineUpdates) {
          await tx.orderLine.updateMany({
            where: {
              orderId: upd.orderId,
              productId: upd.productId,
            },
            data: { deliveredQty: upd.deliveredQty },
          })
        }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `差异处理: 接受${acceptCount}项, 拒绝${rejectCount}项`,
      })

      return NextResponse.json(serializeApi({
        message: `已处理 ${resolutions.length} 项差异`,
        accepted: acceptCount,
        rejected: rejectCount,
      }))
    } catch (error) {
      console.error('[PUT /api/trips/[id]/discrepancy]', error)
      return NextResponse.json({ error: '差异处理失败' }, { status: 500 })
    }
  }, { require: 'dispatch.trip.discrepancy' })
}
