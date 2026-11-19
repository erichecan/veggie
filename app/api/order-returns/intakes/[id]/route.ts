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
      if (!['link', 'reject'].includes(body.action) || !String(body.note ?? '').trim()) return NextResponse.json({ error: '请选择匹配原单或拒绝，并填写核实说明' }, { status: 400 })
      const result = await prisma.$transaction(async tx => {
        if (body.action === 'link') await lockReturnOrders(tx, [String(body.orderId ?? '')])
        await tx.$queryRaw`SELECT id FROM "ReturnIntake" WHERE id = ${id} FOR UPDATE`
        const intake = await tx.returnIntake.findUnique({ where: { id } })
        if (!intake || intake.status !== 'OPEN') returnError('登记不存在或已处理')
        let returnId: string | null = null
        if (body.action === 'link') {
          const order = await tx.order.findUnique({ where: { id: String(body.orderId ?? '') }, select: { restaurantId: true } })
          if (!order || order.restaurantId !== intake.customerId) returnError('必须匹配同一客户的原订单', 400)
          const ret = await createOrderReturn(tx, { orderId: String(body.orderId), orderLineId: String(body.orderLineId ?? ''), quantity: Number(body.quantity), returnKind: 'HISTORICAL', sourceTripId: intake.sourceTripId, reason: [intake.reason, `原登记：${intake.productName} ${intake.spec} × ${intake.quantity} ${intake.uomLabel}`, String(body.note)].filter(Boolean).join(' · '), photo: intake.photo ?? undefined }, user)
          returnId = ret.id
        }
        return tx.returnIntake.update({ where: { id }, data: { status: returnId ? 'LINKED' : 'REJECTED', orderReturnId: returnId, reviewedById: user.userId, reviewedAt: new Date(), reviewNote: String(body.note).trim() } })
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'UPDATE', resource: 'return_intake', resourceId: id, detail: `${result.status}: ${result.reviewNote}` })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : '处理失败' }, { status: Number((error as { status?: number }).status) || 500 })
    }
  }, { require: 'dispatch.goods_return.warehouse_verify' })
}
