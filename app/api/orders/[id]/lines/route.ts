import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { resolveCommissionPrice } from '@/lib/commission'
import { assertOrderNotPickLocked, WavePickLockedError } from '@/lib/wave-pick-lock'

/**
 * POST /api/orders/:id/lines
 * 追加单行商品到订单，并重算订单合计。
 */
export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, code: true, status: true },
      })
      if (!order) {
        return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      }

      const lockedStatuses = ['LOCKED', 'CANCELLED', 'COMPLETED']
      if (lockedStatuses.includes(order.status)) {
        return NextResponse.json({ error: '该订单状态不允许修改明细' }, { status: 403 })
      }
      await assertOrderNotPickLocked(id)

      const {
        productId,
        productName,
        uomId,
        uomName,
        unitPrice,
        orderedQty,
        taxRate,
        sequence,
      } = body

      const productToAdd = await prisma.product.findUnique({
        where: { id: String(productId) },
        include: { template: { select: { canBeSold: true } } },
      })
      if (productToAdd?.template?.canBeSold === false) {
        return NextResponse.json(
          { error: `商品「${productToAdd.name}」已下架，不可加入订单` },
          { status: 400 },
        )
      }

      const subtotal = Math.round(Number(unitPrice) * Number(orderedQty) * 100) / 100
      // SSOT: 追加行同样要写件提成快照,否则该行提成恒为 null
      const commissionPrice = await resolveCommissionPrice(String(productId))

      const newLine = await prisma.orderLine.create({
        data: {
          orderId: id,
          productId,
          productName,
          uomId: uomId ?? null,
          uomName: uomName ?? 'Unit(s)',
          unitPrice: Number(unitPrice),
          orderedQty: Number(orderedQty),
          deliveredQty: 0,
          invoicedQty: 0,
          subtotal,
          taxRate: taxRate != null ? Number(taxRate) : null,
          sequence: sequence ?? 0,
          commissionPrice,
        },
      })

      const allLines = await prisma.orderLine.findMany({
        where: { orderId: id },
        select: { subtotal: true },
      })
      const newTotal = allLines.reduce((s, l) => s + Number(l.subtotal), 0)
      await prisma.order.update({
        where: { id },
        data: { totalAmount: Math.round(newTotal * 100) / 100 },
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'CREATE',
        resource: 'order',
        resourceId: id,
        detail: `追加订单行: ${productName}（数量 ${Number(orderedQty)}，单价 ${Number(unitPrice)}）`,
      })

      return NextResponse.json(newLine, { status: 201 })
    } catch (e) {
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      console.error('[POST order line]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '添加失败' },
        { status: 500 },
      )
    }
  })
}
