import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { createOrderReturn } from '@/lib/order-returns'
import { returnError, lockReturnOrders } from '@/lib/return-invoice-guard'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    try {
      const { id } = await params
      const body = await req.json()
      if (!['link', 'identifyCustomer', 'reject'].includes(body.action) || !String(body.note ?? '').trim()) return NextResponse.json({ error: '请选择客户/原单或拒绝，并填写处理说明' }, { status: 400 })
      const result = await prisma.$transaction(async tx => {
        const source = await tx.returnIntake.findUnique({ where: { id }, select: { candidateOrderIds: true } })
        await lockReturnOrders(tx, [...(source?.candidateOrderIds ?? []), ...(body.action === 'link' && body.orderId ? [String(body.orderId)] : [])])
        await tx.$queryRaw`SELECT id FROM "ReturnIntake" WHERE id = ${id} FOR UPDATE`
        const intake = await tx.returnIntake.findUnique({ where: { id } })
        if (!intake || !['OPEN', 'CUSTOMER_IDENTIFIED'].includes(intake.status)) returnError('登记不存在或已处理')
        const customerId = String(body.customerId ?? intake.customerId ?? '')
        if (body.action !== 'reject' && !customerId) returnError('请选择退货所属餐馆', 400)
        const customer = customerId ? await tx.customer.findUnique({ where: { id: customerId }, select: { id: true, name: true } }) : null
        if (customerId && !customer) returnError('找不到所选餐馆', 404)
        let returnId: string | null = null
        if (body.action === 'link') {
          const order = await tx.order.findUnique({ where: { id: String(body.orderId ?? '') }, select: { restaurantId: true } })
          if (!order || order.restaurantId !== customerId) returnError('必须匹配所选餐馆的原订单', 400)
          const ret = await createOrderReturn(tx, { orderId: String(body.orderId), orderLineId: String(body.orderLineId ?? ''), quantity: Number(body.quantity), returnKind: intake.candidateOrderIds.includes(String(body.orderId)) ? 'CURRENT' : 'HISTORICAL', sourceTripId: intake.sourceTripId ?? undefined, vehiclePlateSnapshot: intake.vehiclePlate ?? undefined, driverNameSnapshot: intake.driverName ?? undefined, actualReturnedProductName: Number(intake.quantity) > 0 ? intake.productName : undefined, reason: [intake.reason, `仓库登记：${intake.productName} ${intake.spec} × ${intake.quantity} ${intake.uomLabel}`, String(body.note)].filter(Boolean).join(' · '), photo: intake.photo ?? undefined }, user)
          returnId = ret.id
        }
        const nextStatus = body.action === 'reject' ? 'REJECTED' : returnId ? 'LINKED' : 'CUSTOMER_IDENTIFIED'
        return tx.returnIntake.update({ where: { id }, data: { status: nextStatus, customerId: customer?.id ?? null, customerName: customer?.name ?? intake.customerName, orderReturnId: returnId, reviewedById: user.userId, reviewedAt: new Date(), reviewNote: String(body.note).trim() } })
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'UPDATE', resource: 'return_intake', resourceId: id, detail: `${result.status}: ${result.reviewNote}` })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : '处理失败' }, { status: Number((error as { status?: number }).status) || 500 })
    }
  }, { require: 'dispatch.goods_return.review' })
}
