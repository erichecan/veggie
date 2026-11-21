import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/** Warehouse intake for returned goods that a driver did not report. */
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const body = await req.json() as Record<string, unknown>
      const plate = String(body.vehiclePlate ?? '').trim().toUpperCase().replace(/\s+/g, ' ')
      const productName = String(body.productName ?? '').trim()
      const spec = String(body.spec ?? '').trim()
      const uomLabel = String(body.uomLabel ?? '').trim()
      const quantity = Number(body.quantity)
      if (!plate || plate.length > 24 || !/^[A-Z0-9 -]+$/.test(plate)) {
        return NextResponse.json({ error: '请输入有效车牌' }, { status: 400 })
      }
      if (!productName || !spec || !uomLabel || !Number.isFinite(quantity) || quantity <= 0 || Math.abs(quantity * 1000 - Math.round(quantity * 1000)) > 0.00001) {
        return NextResponse.json({ error: '请填写商品、规格、单位和有效数量（最多三位小数）' }, { status: 400 })
      }

      const recentTrip = await prisma.trip.findFirst({
        where: { vehiclePlate: plate, createdAt: { gte: new Date(Date.now() - 3 * 24 * 60 * 60 * 1000) } },
        orderBy: { createdAt: 'desc' },
        select: { id: true, driverName: true },
      })
      const customerName = String(body.customerName ?? '').trim().slice(0, 200) || '待销售确认'
      const intake = await prisma.returnIntake.create({
        data: {
          sourceType: 'WAREHOUSE',
          sourceTripId: recentTrip?.id,
          vehiclePlate: plate,
          driverName: String(body.driverName ?? '').trim().slice(0, 120) || recentTrip?.driverName || null,
          customerName,
          productName: productName.slice(0, 200),
          spec: spec.slice(0, 200),
          uomLabel: uomLabel.slice(0, 40),
          quantity,
          reason: String(body.reason ?? '').trim().slice(0, 1000) || null,
          photo: typeof body.photo === 'string' && body.photo.trim() ? body.photo.trim() : null,
          reportedById: user.userId,
        },
      })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'return_intake', resourceId: intake.id,
        detail: `仓库登记漏报退货: ${plate} — ${productName} × ${quantity}`,
      })
      return NextResponse.json(serializeApi(intake), { status: 201 })
    } catch (error) {
      console.error('[POST /api/order-returns/intakes]', error)
      return NextResponse.json({ error: '仓库登记退回商品失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.warehouse_verify' })
}
