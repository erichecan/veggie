import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { writeLog } from '@/lib/action-log'
import { consumeLotsFIFO, restoreLotsFIFO, toStockQty } from '@/lib/inventory'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const disc = await prisma.orderDiscrepancy.findUnique({
        where: { id },
        include: {
          order: { select: { code: true, restaurantName: true, status: true, deliveryDate: true } },
        },
      })
      if (!disc) return NextResponse.json({ error: '差异记录不存在' }, { status: 404 })
      return NextResponse.json(serializeApi(disc))
    } catch (error) {
      console.error('[GET /api/order-discrepancies/[id]]', error)
      return NextResponse.json({ error: '获取差异记录失败' }, { status: 500 })
    }
  })
}

/**
 * PUT /api/order-discrepancies/[id] — 处理差异
 *
 * resolution 类型:
 * - ADJUST_QTY: 调整订单行数量为 pickedQty（退回差额库存）
 * - SUBSTITUTE: 替代商品（原行减到 pickedQty，新增替代行）
 * - CANCEL_LINE: 取消该订单行（退回全部库存）
 * - REPLENISH: 补货（不修改订单，标记差异已解决，等待补货到位）
 */
export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const { resolution, substituteProductId, substituteProductName, substituteQty, substituteUnitPrice, note } = body

      const disc = await prisma.orderDiscrepancy.findUnique({ where: { id } })
      if (!disc) return NextResponse.json({ error: '差异记录不存在' }, { status: 404 })
      if (disc.status !== 'PENDING') {
        return NextResponse.json({ error: '该差异已处理' }, { status: 409 })
      }

      const validResolutions = ['ADJUST_QTY', 'SUBSTITUTE', 'CANCEL_LINE', 'REPLENISH']
      if (!resolution || !validResolutions.includes(resolution)) {
        return NextResponse.json({ error: `处理方式无效，允许: ${validResolutions.join(', ')}` }, { status: 400 })
      }

      const order = await prisma.order.findUnique({
        where: { id: disc.orderId },
        select: { id: true, code: true, status: true, deliveryDate: true },
      })
      if (!order) return NextResponse.json({ error: '关联订单不存在' }, { status: 404 })

      const line = await prisma.orderLine.findUnique({
        where: { id: disc.orderLineId },
        include: { product: { include: { template: { select: { type: true } } } } },
      })
      if (!line) return NextResponse.json({ error: '关联订单行不存在' }, { status: 404 })

      const movedAt = order.deliveryDate ? new Date(order.deliveryDate as unknown as string) : new Date()
      const isProduct = line.product && line.product.template?.type === 'PRODUCT'
      const orderRef = order.code ?? disc.orderId

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const px = prisma as any

      if (resolution === 'ADJUST_QTY') {
        const newQty = toNum(disc.pickedQty)
        const oldQty = toNum(line.orderedQty)
        const releaseQty = oldQty - newQty

        await prisma.orderLine.update({
          where: { id: disc.orderLineId },
          data: {
            orderedQty: newQty,
            subtotal: newQty * toNum(line.unitPrice),
          },
        })

        if (isProduct && releaseQty > 0) {
          const stockReleaseQty = await toStockQty(px, line.productId, releaseQty, line.uomId)
          await px.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: stockReleaseQty } },
          })
          await restoreLotsFIFO(px, line.productId, stockReleaseQty)
          await px.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName,
              type: 'IN',
              qty: stockReleaseQty,
              movedAt,
              note: `差异处理 ${disc.code}: 调整数量 ${oldQty}→${newQty}`,
              sourceType: 'ORDER',
              sourceId: disc.orderId,
              sourceRef: orderRef,
            },
          })
        }

        await recalcOrderTotal(disc.orderId)
      } else if (resolution === 'SUBSTITUTE') {
        if (!substituteProductId || !substituteProductName || !substituteQty || !substituteUnitPrice) {
          return NextResponse.json({ error: '替代商品信息不完整' }, { status: 400 })
        }

        const oldQty = toNum(line.orderedQty)
        const pickedQty = toNum(disc.pickedQty)
        const releaseQty = oldQty - pickedQty

        if (pickedQty > 0) {
          await prisma.orderLine.update({
            where: { id: disc.orderLineId },
            data: {
              orderedQty: pickedQty,
              subtotal: pickedQty * toNum(line.unitPrice),
            },
          })
        } else {
          await prisma.orderLine.delete({ where: { id: disc.orderLineId } })
        }

        if (isProduct && releaseQty > 0) {
          const stockReleaseQty = await toStockQty(px, line.productId, releaseQty, line.uomId)
          await px.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: stockReleaseQty } },
          })
          await restoreLotsFIFO(px, line.productId, stockReleaseQty)
          await px.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName,
              type: 'IN',
              qty: stockReleaseQty,
              movedAt,
              note: `差异处理 ${disc.code}: 原商品释放 ${oldQty}→${pickedQty}`,
              sourceType: 'ORDER',
              sourceId: disc.orderId,
              sourceRef: orderRef,
            },
          })
        }

        const subProduct = await px.product.findUnique({
          where: { id: substituteProductId },
          include: { template: { select: { type: true } } },
        })

        const maxSeq = await prisma.orderLine.aggregate({
          where: { orderId: disc.orderId },
          _max: { sequence: true },
        })

        await prisma.orderLine.create({
          data: {
            orderId: disc.orderId,
            productId: substituteProductId,
            productName: substituteProductName,
            unitPrice: Number(substituteUnitPrice),
            orderedQty: Number(substituteQty),
            subtotal: Number(substituteQty) * Number(substituteUnitPrice),
            deliveredQty: 0,
            invoicedQty: 0,
            sequence: (maxSeq._max.sequence ?? 0) + 1,
          },
        })

        if (subProduct?.template?.type === 'PRODUCT') {
          await px.product.update({
            where: { id: substituteProductId },
            data: { qtyOnHand: { decrement: Number(substituteQty) } },
          })
          await consumeLotsFIFO(px, substituteProductId, Number(substituteQty))
          await px.stockMove.create({
            data: {
              productId: substituteProductId,
              productName: substituteProductName,
              type: 'OUT',
              qty: -Number(substituteQty),
              movedAt,
              note: `差异处理 ${disc.code}: 替代商品扣减`,
              sourceType: 'ORDER',
              sourceId: disc.orderId,
              sourceRef: orderRef,
            },
          })
        }

        await recalcOrderTotal(disc.orderId)
      } else if (resolution === 'CANCEL_LINE') {
        const oldQty = toNum(line.orderedQty)

        await prisma.orderLine.delete({ where: { id: disc.orderLineId } })

        if (isProduct && oldQty > 0) {
          const stockQty = await toStockQty(px, line.productId, oldQty, line.uomId)
          await px.product.update({
            where: { id: line.productId },
            data: { qtyOnHand: { increment: stockQty } },
          })
          await restoreLotsFIFO(px, line.productId, stockQty)
          await px.stockMove.create({
            data: {
              productId: line.productId,
              productName: line.productName,
              type: 'IN',
              qty: stockQty,
              movedAt,
              note: `差异处理 ${disc.code}: 取消订单行释放`,
              sourceType: 'ORDER',
              sourceId: disc.orderId,
              sourceRef: orderRef,
            },
          })
        }

        await recalcOrderTotal(disc.orderId)
      }
      // REPLENISH: 不修改订单，仅标记差异已处理

      const updated = await prisma.orderDiscrepancy.update({
        where: { id },
        data: {
          status: 'RESOLVED',
          resolution,
          substituteProductId: substituteProductId || null,
          substituteProductName: substituteProductName || null,
          substituteQty: substituteQty ? Number(substituteQty) : null,
          substituteUnitPrice: substituteUnitPrice ? Number(substituteUnitPrice) : null,
          note: note || disc.note,
          resolvedBy: user.userId,
          resolvedByName: user.name,
          resolvedAt: new Date(),
        },
        include: {
          order: { select: { code: true, restaurantName: true, status: true } },
        },
      })

      await px.orderAuditLog.create({
        data: {
          orderId: disc.orderId,
          userId: user.userId,
          action: 'discrepancy_resolved',
          changedFields: {
            discrepancyCode: disc.code,
            type: disc.type,
            resolution,
            productName: disc.productName,
            orderedQty: toNum(disc.orderedQty),
            pickedQty: toNum(disc.pickedQty),
            ...(substituteProductName ? { substituteProductName, substituteQty: Number(substituteQty) } : {}),
          },
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order_discrepancy', resourceId: disc.id,
        detail: `处理差异 ${disc.code}: ${resolution}, 订单 ${orderRef}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/order-discrepancies/[id]]', error)
      return NextResponse.json({ error: '处理差异失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}

async function recalcOrderTotal(orderId: string) {
  const lines = await prisma.orderLine.findMany({ where: { orderId } })
  const total = lines.reduce((sum, l) => sum + toNum(l.subtotal), 0)
  await prisma.order.update({ where: { id: orderId }, data: { totalAmount: total } })
}
