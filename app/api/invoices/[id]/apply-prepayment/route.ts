import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { applyPrepaymentToInvoice } from '@/lib/prepayments'
import { round2 } from '@/lib/decimal-helpers'

/**
 * POST /api/invoices/:id/apply-prepayment
 * ============================================================================
 * 用客户的预付款余额冲抵一张发票。body: { amount }
 *
 * 事务内：校验预付款余额充足 + 不超过发票剩余应付 → 写一条
 * source=PREPAYMENT_APPLIED 的 Payment（关联该发票）→ 过账 Dr 2300 / Cr AR
 * （不产生新现金流）→ 按普通收款同样的方式回写 Invoice.amountPaid/amountDue。
 * 核心逻辑在 lib/prepayments.ts#applyPrepaymentToInvoice，供测试直接调用。
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()
      const amount = round2(Number(data.amount))
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: '冲抵金额必须大于 0' }, { status: 400 })
      }

      const result = await prisma.$transaction(tx => applyPrepaymentToInvoice(tx, {
        invoiceId: id,
        amount,
        actor: { userId: user.userId, name: user.name, email: user.email },
      }))

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'payment', resourceId: result.payment.id,
        detail: `发票 ${result.invoice.name} 用预付款冲抵 €${amount.toFixed(2)}`,
      })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/invoices/[id]/apply-prepayment]', error)
      return NextResponse.json({ error: '预付款冲抵失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.pay' })
}
