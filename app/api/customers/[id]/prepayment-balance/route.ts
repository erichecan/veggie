import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { computePrepaymentBalance } from '@/lib/prepayments'
import { toNum } from '@/lib/decimal-helpers'

/**
 * GET /api/customers/:id/prepayment-balance
 * ============================================================================
 * 返回客户当前预付款余额（实时计算，不缓存）。
 *
 * ⛔ 故意不用 withCachedAuth——余额会因为财务刚登记/冲抵一笔预付款而立刻变化，
 * 缓存会让人以为操作没生效。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      const payments = await prisma.payment.findMany({
        where: { customerId: id, source: { in: ['PREPAYMENT_RECEIVED', 'PREPAYMENT_APPLIED'] } },
        select: { source: true, amount: true },
      })
      const balance = computePrepaymentBalance(
        payments.map(p => ({ source: p.source, amount: toNum(p.amount) })),
      )
      return NextResponse.json({ customerId: id, balance })
    } catch (error) {
      console.error('[GET /api/customers/[id]/prepayment-balance]', error)
      return NextResponse.json({ error: '获取预付款余额失败' }, { status: 500 })
    }
  }, { require: 'finance.payment.read' })
}
