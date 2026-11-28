
import { apiRouteErrorResponse } from '@/lib/api-route-error'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { round2, toNum } from '@/lib/decimal-helpers'
import { resolvePortalOwnerIds } from '@/lib/customer-portal-auth'

/** Customer-safe credit balance list. Drafts, cancellations, notes and allocation metadata stay private. */
export async function GET(req: Request) {
  return withAuth(req, async user => {
    try {
      const customerIds = await resolvePortalOwnerIds(user.userId, user.customerId)
      const { searchParams } = new URL(req.url)
      const page = Math.max(1, Number(searchParams.get('page')) || 1)
      const pageSize = Math.min(50, Math.max(1, Number(searchParams.get('pageSize')) || 20))
      const where = { customerId: { in: customerIds }, status: { in: ['CONFIRMED', 'APPLIED', 'SETTLED'] } }
      const [items, total] = await Promise.all([
        prisma.creditNote.findMany({ where, orderBy: { creditDate: 'desc' }, skip: (page - 1) * pageSize, take: pageSize,
          select: { id: true, name: true, creditDate: true, totalIncTax: true, status: true } }),
        prisma.creditNote.count({ where }),
      ])
      const allocations = items.length ? await prisma.creditNoteAllocation.groupBy({
        by: ['creditNoteId'], where: { creditNoteId: { in: items.map(item => item.id) } }, _sum: { amount: true },
      }) : []
      const appliedById = new Map(allocations.map(row => [row.creditNoteId, toNum(row._sum.amount ?? 0)]))
      const safeItems = items.map(item => {
        const amount = toNum(item.totalIncTax)
        const applied = appliedById.get(item.id) ?? 0
        return { id: item.id, name: item.name, creditDate: item.creditDate, status: item.status, amount, applied: round2(applied), remaining: round2(amount - applied) }
      })
      return NextResponse.json(serializeApi({ items: safeItems, total, page, pageSize }))
    } catch (error) {
      console.error('[GET /api/customer-portal/credit-notes]', error)
      return apiRouteErrorResponse(error, '获取 credit 余额失败')
    }
  }, { require: 'portal.self.access' })
}
