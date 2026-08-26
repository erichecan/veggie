import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { checkCustomerCredit } from '@/lib/credit-check'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: {
        id: true, name: true, paymentTerm: true, creditLimit: true,
        termExtendedUntil: true, termExtendedNote: true,
      },
    })
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

    const result = await checkCustomerCredit(prisma, {
      customerId: customer.id,
      paymentTerm: customer.paymentTerm,
      creditLimit: customer.creditLimit,
      termExtendedUntil: customer.termExtendedUntil,
    })

    return NextResponse.json({
      customerId: customer.id,
      customerName: customer.name,
      paymentTerm: customer.paymentTerm,
      creditLimit: result.creditLimit,
      outstandingBalance: result.outstandingBalance,
      overdueAmount: result.overdueAmount,
      canOrder: !result.blocked,
      blockReason: result.blockReason,
      isTermExtended: result.isTermExtended,
      termExtendedUntil: result.termExtendedUntil,
      termExtendedNote: customer.termExtendedNote,
    })
  })
}
