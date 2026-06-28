import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    const customer = await prisma.customer.findUnique({
      where: { id },
      select: { id: true, name: true, paymentTerm: true, creditLimit: true },
    })
    if (!customer) return NextResponse.json({ error: '客户不存在' }, { status: 404 })

    const invoices = await prisma.invoice.findMany({
      where: { customerId: id, status: 'POSTED' },
      select: { amountDue: true, dueDate: true },
    })

    const outstandingBalance = invoices.reduce((s, inv) => s + Number(inv.amountDue), 0)
    const today = new Date().toISOString().slice(0, 10)
    const overdueAmount = invoices
      .filter(inv => inv.dueDate && inv.dueDate < today)
      .reduce((s, inv) => s + Number(inv.amountDue), 0)

    const creditLimit = Number(customer.creditLimit ?? 0)
    const paymentTerm = customer.paymentTerm

    let canOrder = true
    let blockReason: string | undefined

    if (paymentTerm !== 'cash') {
      if (creditLimit > 0 && outstandingBalance >= creditLimit) {
        canOrder = false
        blockReason = `欠款 €${outstandingBalance.toFixed(2)} 已达信用额度上限 €${creditLimit.toFixed(2)}`
      } else if (overdueAmount > 0 && paymentTerm === 'monthly') {
        canOrder = false
        blockReason = `有逾期欠款 €${overdueAmount.toFixed(2)}，月结账期已超`
      }
    }

    return NextResponse.json({
      customerId: customer.id,
      customerName: customer.name,
      paymentTerm,
      creditLimit,
      outstandingBalance,
      overdueAmount,
      canOrder,
      blockReason,
    })
  })
}
