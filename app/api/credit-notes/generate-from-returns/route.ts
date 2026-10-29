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
 * body: { tripIds?: string[], orderReturnIds?: string[] }（至少给一个非空数组）
 *
 * 逻辑：
 * 1. 扫描指定行程中所有 APPROVED 状态的退货记录（Trip 路径，司机报备）；
 *    扫描指定 id 中所有 APPROVED 状态的 OrderReturn（手工登记路径，20261028 M7 补）
 * 2. 两条路径按客户（restaurantId）合并，每个客户生成一张 CreditNote
 * 3. 将退货记录状态更新为 SETTLED
 * 4. P0-3 退货日期使用今天（creditDate = today）
 */

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const tripIds = (body.tripIds as string[] | undefined) ?? []
      const orderReturnIds = (body.orderReturnIds as string[] | undefined) ?? []

      if (tripIds.length === 0 && orderReturnIds.length === 0) {
        return NextResponse.json({ error: '缺少 tripIds 或 orderReturnIds' }, { status: 400 })
      }
      if (tripIds.length > 50) {
        return NextResponse.json({ error: '一次最多处理 50 个行程' }, { status: 400 })
      }
      if (orderReturnIds.length > 50) {
        return NextResponse.json({ error: '一次最多处理 50 条退货登记' }, { status: 400 })
      }

      const trips = tripIds.length > 0 ? await prisma.trip.findMany({
        where: { id: { in: tripIds } },
        select: { id: true, name: true, restaurants: true },
      }) : []

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
          sourceTripId: string | null
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

      // 手工登记路径（OrderReturn，20261028 M7）：按 id 精确查已批准的记录，
      // unitPrice 没有存在 OrderReturn 上（创建时只做了存在性校验），在这里按
      // orderId+productId 补查一次 OrderLine，跟登记时的查法一致。
      // 批量查（而非逐条 findFirst），同批 Trip 路径早就是这么做的。
      const settledOrderReturnIds: string[] = []
      if (orderReturnIds.length > 0) {
        const orderReturns = await prisma.orderReturn.findMany({
          where: { id: { in: orderReturnIds }, status: 'APPROVED' },
          include: { order: { select: { restaurantId: true, restaurantName: true } } },
        })
        const orderIds = [...new Set(orderReturns.map(r => r.orderId))]
        const productIds = [...new Set(orderReturns.map(r => r.productId))]
        const priceLines = orderIds.length > 0 ? await prisma.orderLine.findMany({
          where: { orderId: { in: orderIds }, productId: { in: productIds } },
          select: { orderId: true, productId: true, unitPrice: true },
        }) : []
        const priceMap = new Map(priceLines.map(l => [`${l.orderId}:${l.productId}`, l.unitPrice]))

        const unpriced = orderReturns.filter(ret => !priceMap.has(`${ret.orderId}:${ret.productId}`))
        if (unpriced.length > 0) {
          return NextResponse.json({
            error: `以下退货记录在原订单里找不到对应商品行，无法确定单价，已中止生成：${unpriced.map(r => r.id).join(', ')}`,
          }, { status: 400 })
        }

        for (const ret of orderReturns) {
          const customerId = ret.order.restaurantId
          if (!customerReturns.has(customerId)) {
            customerReturns.set(customerId, {
              customerName: ret.order.restaurantName,
              lines: [],
            })
          }
          customerReturns.get(customerId)!.lines.push({
            productId: ret.productId,
            productName: ret.productName,
            quantity: toNum(ret.quantity),
            unitPrice: toNum(priceMap.get(`${ret.orderId}:${ret.productId}`)!),
            reason: ret.reason ?? null,
            sourceOrderId: ret.orderId,
            sourceTripId: null,
          })
          settledOrderReturnIds.push(ret.id)
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

        // 更新手工登记退货状态（20261028 M7）。where 带 status:'APPROVED' + 校验受影响行数，
        // 防止与另一个并发请求结算同一条 OrderReturn 产生两张 CreditNote（TOCTOU）。
        if (settledOrderReturnIds.length > 0) {
          const settleResult = await tx.orderReturn.updateMany({
            where: { id: { in: settledOrderReturnIds }, status: 'APPROVED' },
            data: { status: 'SETTLED', settledAt: today },
          })
          if (settleResult.count !== settledOrderReturnIds.length) {
            throw new Error('ORDER_RETURN_ALREADY_SETTLED')
          }
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
              notes: `从退货自动生成 — ${tripIds.length}个行程 + ${settledOrderReturnIds.length}条登记`,
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
      if (error instanceof Error && error.message === 'ORDER_RETURN_ALREADY_SETTLED') {
        return NextResponse.json({ error: '部分退货记录已被其他请求结算，请刷新后重试' }, { status: 409 })
      }
      console.error('[POST /api/credit-notes/generate-from-returns]', error)
      return NextResponse.json({ error: '生成退款单失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.create' })
}
