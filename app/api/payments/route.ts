import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum, round2 } from '@/lib/decimal-helpers'

/**
 * /api/payments — 发票分笔收款
 * ============================================================================
 * GET  ?invoiceId= | ?customerId=  — 收款流水
 * POST { invoiceId, amount, method?, paidAt?, note? }
 *   事务内:创建 Payment + 重算 Invoice.amountPaid/amountDue;
 *   付清自动转 PAID;仅 POSTED/PAID 状态的发票可收款。
 */

const VALID_METHODS = new Set(['cash', 'transfer', 'other'])

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const { searchParams } = new URL(req.url)
      const invoiceId = searchParams.get('invoiceId')
      const customerId = searchParams.get('customerId')
      const where: Record<string, unknown> = {}
      if (invoiceId) where.invoiceId = invoiceId
      if (customerId) where.customerId = customerId

      const payments = await prisma.payment.findMany({
        where,
        orderBy: { paidAt: 'desc' },
        take: 500,
      })
      return NextResponse.json(serializeApi(payments))
    } catch (error) {
      console.error('[GET /api/payments]', error)
      return NextResponse.json({ error: '获取收款记录失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const invoiceId = String(data.invoiceId ?? '').trim()
      const amount = round2(Number(data.amount))
      const method = String(data.method ?? 'transfer').toLowerCase()

      if (!invoiceId) return NextResponse.json({ error: 'invoiceId 必填' }, { status: 400 })
      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: '收款金额必须大于 0' }, { status: 400 })
      }
      if (!VALID_METHODS.has(method)) {
        return NextResponse.json({ error: '收款方式无效(cash/transfer/other)' }, { status: 400 })
      }

      const result = await prisma.$transaction(async tx => {
        const invoice = await tx.invoice.findUnique({ where: { id: invoiceId } })
        if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
        if (!['POSTED', 'PAID'].includes(String(invoice.status))) {
          throw Object.assign(new Error('仅已确认(POSTED)的发票可登记收款'), { status: 400 })
        }

        const total = toNum(invoice.totalIncTax)
        const alreadyPaid = toNum(invoice.amountPaid)
        if (alreadyPaid + amount > total + 0.005) {
          throw Object.assign(
            new Error(`收款超额:已付 €${alreadyPaid.toFixed(2)} + 本笔 €${amount.toFixed(2)} > 总额 €${total.toFixed(2)}`),
            { status: 400 },
          )
        }

        const payment = await tx.payment.create({
          data: {
            invoiceId,
            customerId: invoice.customerId,
            amount,
            method,
            paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
            note: data.note ? String(data.note).trim().slice(0, 500) : null,
            createdBy: user.name ?? user.email,
          },
        })

        const newPaid = round2(alreadyPaid + amount)
        const newDue = round2(total - newPaid)
        const fullyPaid = newDue <= 0.005
        const invoiceAfter = await tx.invoice.update({
          where: { id: invoiceId },
          data: {
            amountPaid: newPaid,
            amountDue: Math.max(0, newDue),
            ...(fullyPaid
              ? { status: 'PAID', paidAt: new Date().toISOString() }
              : {}),
          },
        })
        return { payment, invoice: invoiceAfter }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'payment', resourceId: result.payment.id,
        detail: `发票 ${result.invoice.name} 收款 €${amount.toFixed(2)} (${method})`,
      })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/payments]', error)
      return NextResponse.json({ error: '登记收款失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
