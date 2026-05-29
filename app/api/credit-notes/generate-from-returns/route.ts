import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum, round2 } from '@/lib/decimal-helpers'
import type { TripRestaurant, ReturnItem } from '@/lib/types'

/**
 * P0-3: 从已审批退货批量生成 CreditNote
 *
 * POST /api/credit-notes/generate-from-returns
 * body: { tripIds: string[] }
 *
 * 逻辑：
 * 1. 扫描指定行程中所有 APPROVED 状态的退货记录
 * 2. 按客户（restaurantId）合并，每个客户生成一张 CreditNote
 * 3. 将退货记录状态更新为 SETTLED
 * 4. P0-3 退货日期使用今天（creditDate = today）
 */

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const tripIds = body.tripIds as string[] | undefined

      if (!Array.isArray(tripIds) || tripIds.length === 0) {
        return NextResponse.json({ error: '缺少 tripIds' }, { status: 400 })
      }
      if (tripIds.length > 50) {
        return NextResponse.json({ error: '一次最多处理 50 个行程' }, { status: 400 })
      }

      const trips = await prisma.trip.findMany({
        where: { id: { in: tripIds } },
        select: { id: true, name: true, restaurants: true },
      })

      // 按客户聚合所有 APPROVED 退货
      const customerReturns = new Map<string, {
        customerName: string
        lines: Array<{
          productId: string
          productName: string
          quantity: number
          unitPrice: number
          reason: string | null
          sourceOrderId: string | null
          sourceTripId: string
        }>
      }>()

      // 同时收集需要更新状态的退货位置
      const tripUpdates: Array<{
        tripId: string
        restaurants: TripRestaurant[]
      }> = []

      for (const trip of trips) {
        const restaurants = (trip.restaurants ?? []) as unknown as TripRestaurant[]
        let tripModified = false

        for (const restaurant of restaurants) {
          const returns = restaurant.returns ?? []
          for (let i = 0; i < returns.length; i++) {
            const ret = returns[i]
            if (ret.status !== 'APPROVED') continue

            const customerId = restaurant.restaurantId
            if (!customerReturns.has(customerId)) {
              customerReturns.set(customerId, {
                customerName: restaurant.restaurantName,
                lines: [],
              })
            }

            customerReturns.get(customerId)!.lines.push({
              productId: ret.productId,
              productName: ret.productName,
              quantity: toNum(ret.quantity),
              unitPrice: toNum(ret.unitPrice),
              reason: ret.reason ?? null,
              sourceOrderId: restaurant.orderIds?.[0] ?? null,
              sourceTripId: trip.id,
            })

            // 标记为 SETTLED
            returns[i] = { ...ret, status: 'SETTLED', settledAt: new Date().toISOString() }
            tripModified = true
          }
        }

        if (tripModified) {
          tripUpdates.push({ tripId: trip.id, restaurants })
        }
      }

      if (customerReturns.size === 0) {
        return NextResponse.json({ error: '未找到已审批的退货记录' }, { status: 400 })
      }

      // 生成 CreditNote（每个客户一张）
      const today = new Date()
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
      let seqStart = await prisma.creditNote.count({
        where: {
          createdAt: {
            gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
          },
        },
      })

      const createdNotes: Array<{ id: string; name: string; customerName: string; totalIncTax: number; lineCount: number }> = []

      await prisma.$transaction(async (tx) => {
        // 更新行程退货状态
        for (const upd of tripUpdates) {
          await tx.trip.update({
            where: { id: upd.tripId },
            data: { restaurants: upd.restaurants as never },
          })
        }

        // 为每个客户创建 CreditNote
        for (const [customerId, data] of customerReturns) {
          seqStart++
          const name = `CN-${dateStr}-${String(seqStart).padStart(4, '0')}`

          let subtotalExTax = 0
          const lineData = data.lines.map((l, idx) => {
            const lineSubtotal = round2(l.quantity * l.unitPrice)
            subtotalExTax += lineSubtotal
            return {
              productId: l.productId,
              productName: l.productName,
              quantity: l.quantity,
              unitPrice: l.unitPrice,
              taxRate: 0,
              subtotalExTax: lineSubtotal,
              taxAmount: 0,
              subtotalIncTax: lineSubtotal,
              reason: l.reason,
              sourceOrderId: l.sourceOrderId,
              sourceTripId: l.sourceTripId,
              sequence: idx,
            }
          })

          subtotalExTax = round2(subtotalExTax)

          const cn = await tx.creditNote.create({
            data: {
              name,
              customerId,
              customerName: data.customerName,
              creditDate: today,
              currency: 'EUR',
              subtotalExTax,
              totalTax: 0,
              totalIncTax: subtotalExTax,
              status: 'CONFIRMED',
              notes: `从退货自动生成 — ${tripIds.length}个行程`,
              createdBy: user.userId,
              lines: { create: lineData },
            },
          })

          createdNotes.push({
            id: cn.id,
            name,
            customerName: data.customerName,
            totalIncTax: subtotalExTax,
            lineCount: lineData.length,
          })
        }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'credit-note',
        resourceId: createdNotes.map(n => n.id).join(','),
        detail: `从退货生成 ${createdNotes.length} 张退款单`,
      })

      return NextResponse.json(serializeApi({
        ok: true,
        created: createdNotes.length,
        creditNotes: createdNotes,
      }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/credit-notes/generate-from-returns]', error)
      return NextResponse.json({ error: '生成退款单失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'FINANCE'])
}
