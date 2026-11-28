
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { resolvePortalOwnerIds } from '@/lib/customer-portal-auth'

/** Customer-visible statements are issued statements only; the owner comes from the session. */
export async function GET(req: Request) {
  return withAuth(req, async user => {
    try {
      const customerIds = await resolvePortalOwnerIds(user.userId, user.customerId)
      const { searchParams } = new URL(req.url)
      const page = Math.max(1, Number(searchParams.get('page')) || 1)
      const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize')) || 20))
      const where = { customerId: { in: customerIds }, status: 'sent' }
      const [items, total] = await Promise.all([
        prisma.statement.findMany({ where, orderBy: [{ periodEnd: 'desc' }, { createdAt: 'desc' }], skip: (page - 1) * pageSize, take: pageSize,
          select: { id: true, customerName: true, periodStart: true, periodEnd: true, openingBalance: true, totalSales: true, totalPayments: true, totalCredits: true, closingBalance: true, sentAt: true } }),
        prisma.statement.count({ where }),
      ])
      return NextResponse.json(serializeApi({ items, total, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/customer-portal/statements]', error)
      return apiRouteErrorResponse(error, '获取对账单失败')
    }
  }, { require: 'portal.self.access' })
}
