
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { driverRowScope } from '@/lib/row-scope'
import { describeIssues, reconcileSignatures } from '@/lib/trip-signature'

/** Save a single stop's customer signature without resending the whole trip JSON. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async user => {
    try {
      const body = await req.json() as { restaurantId?: unknown; signature?: unknown; signerName?: unknown }
      const restaurantId = typeof body.restaurantId === 'string' ? body.restaurantId : ''
      if (!restaurantId || typeof body.signature !== 'string' || typeof body.signerName !== 'string') {
        return NextResponse.json({ error: '缺少站点、签名或签收人姓名' }, { status: 400 })
      }

      const trip = await prisma.trip.findUnique({ where: { id } })
      if (!trip) return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      const driverScope = driverRowScope(user)
      if (driverScope && trip.driverId !== driverScope.userId) {
        return NextResponse.json({ error: '行程不存在' }, { status: 404 })
      }

      const restaurants = Array.isArray(trip.restaurants)
        ? trip.restaurants as Array<Record<string, unknown> & { restaurantId?: string }>
        : []
      const index = restaurants.findIndex(row => row.restaurantId === restaurantId)
      if (index < 0) return NextResponse.json({ error: '行程中找不到该客户站点' }, { status: 404 })
      const current = restaurants[index]
      if (current.signature) {
        return NextResponse.json({ error: '该站点已经签收，请刷新行程查看' }, { status: 409 })
      }
      if (current.delivered) {
        return NextResponse.json({ error: '该站点已完成，不能重复签收' }, { status: 409 })
      }

      const customer = await prisma.customer.findUnique({ where: { id: restaurantId }, select: { creditLimit: true } })
      const isCashOnDelivery = Number(customer?.creditLimit ?? 0) <= 0
      const amount = Number(current.payment)
      if (isCashOnDelivery && (!Number.isFinite(amount) || amount < 0)) {
        return NextResponse.json({ error: '请先填写货到现金实收金额' }, { status: 400 })
      }

      const candidate = {
        ...current,
        delivered: true,
        signature: body.signature,
        signerName: body.signerName,
        payment: isCashOnDelivery ? amount : 0,
        paymentMethod: isCashOnDelivery ? 'CASH' : null,
      }
      const checked = reconcileSignatures([], [candidate], new Date())
      if (checked.issues.length) {
        return NextResponse.json({ error: describeIssues(checked.issues) }, { status: 400 })
      }

      const nextRestaurants = [...restaurants]
      nextRestaurants[index] = checked.restaurants[0] as typeof current
      const updated = await prisma.trip.update({
        where: { id },
        data: {
          restaurants: nextRestaurants as never,
          totalPayment: nextRestaurants.reduce((sum, restaurant) => {
            const payment = Number(restaurant.payment)
            return sum + (Number.isFinite(payment) && payment >= 0 ? payment : 0)
          }, 0),
        },
      })

      // A logging outage must not turn a committed signature into a reported save failure.
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'trip', resourceId: id,
        detail: `客户签收：站点 ${restaurantId}`,
        changes: { signature: { restaurantId, signed: true, signerName: String(body.signerName).trim().slice(0, 40) } },
      }).catch(error => console.error('[POST /api/trips/[id]/signature] audit log failed', error))

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[POST /api/trips/[id]/signature]', error)
      return apiRouteErrorResponse(error, '签收保存失败，请重试')
    }
  }, { require: 'dispatch.trip.sign_delivery' })
}
