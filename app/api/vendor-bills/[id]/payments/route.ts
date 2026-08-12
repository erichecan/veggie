import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postVendorPaymentToJournal } from '@/lib/accounting'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { VENDOR_PAYMENT_METHODS, applyVendorPayment } from '@/lib/finance/vendor-settlement'

/**
 * /api/vendor-bills/[id]/payments —— 供应商分批付款（台账 G2）
 * ============================================================================
 * GET  — 该账单的付款流水（逐笔）
 * POST — 登记**一笔**付款 { amount, method?, paidAt?, note? }
 *
 * ⛔ 与被它取代的写法的关键差别：这里收的是**本笔金额**，累计由服务端加。
 * 原先 PUT 收的是「累计已付」，前端读到 100 再传 150 —— read-modify-write。
 * 两个人同时各付 €50（都读到 100，都传 150），最终账上只记下一笔，
 * 少的那 €50 不会报错、不会留痕，只是消失。这类丢账事后几乎无法追。
 *
 * 事务内做三件事，缺一不可：写流水 → 重算账单 amountPaid/amountDue（由流水汇总而来，
 * 不是各自累加）→ 生成付款凭证。付清自动转 PAID。
 */

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await ctx.params
      const payments = await prisma.vendorPayment.findMany({
        where: { vendorBillId: id },
        orderBy: { paidAt: 'asc' },
      })
      const sum = round2(payments.reduce((s, p) => s + toNum(p.amount), 0))
      return NextResponse.json(serializeApi({ items: payments, count: payments.length, sum }))
    } catch (error) {
      console.error('[GET /api/vendor-bills/[id]/payments]', error)
      return NextResponse.json({ error: '获取付款流水失败' }, { status: 500 })
    }
  }, { require: 'finance.vendor_bill.read' })
}

export async function POST(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await ctx.params
      const data = await req.json()
      const amount = round2(Number(data.amount))
      const method = String(data.method ?? 'bank').toLowerCase()

      if (!Number.isFinite(amount) || amount <= 0) {
        return NextResponse.json({ error: '付款金额必须大于 0' }, { status: 400 })
      }
      if (!VENDOR_PAYMENT_METHODS.includes(method as never)) {
        return NextResponse.json({ error: `付款方式无效（${VENDOR_PAYMENT_METHODS.join('/')}）` }, { status: 400 })
      }

      const result = await prisma.$transaction(async (tx) => {
        // 行锁：并发的两笔付款必须排队，否则各自读到同一个「已付」再各自算余额，
        // 超额校验会同时通过（这正是本次要消灭的丢账/超付路径）
        await tx.$queryRaw`SELECT id FROM "VendorBill" WHERE id = ${id} FOR UPDATE`
        const bill = await tx.vendorBill.findUnique({ where: { id } })
        if (!bill) throw Object.assign(new Error('账单不存在'), { status: 404 })
        if (!['POSTED', 'PAID'].includes(String(bill.status))) {
          throw Object.assign(new Error(`仅已过账(POSTED)的账单可登记付款（当前 ${bill.status}）`), { status: 400 })
        }

        const paidSoFar = await tx.vendorPayment.aggregate({ where: { vendorBillId: id }, _sum: { amount: true } })
        const plan = applyVendorPayment({
          totalIncTax: toNum(bill.totalIncTax),
          paidSoFar: toNum(paidSoFar._sum.amount ?? 0),
          amount,
        })
        if (plan.error) throw Object.assign(new Error(plan.error), { status: 400 })

        const payment = await tx.vendorPayment.create({
          data: {
            vendorBillId: id,
            supplierId: bill.supplierId,
            amount,
            method,
            paidAt: data.paidAt ? new Date(data.paidAt) : new Date(),
            note: data.note ? String(data.note).trim().slice(0, 500) : null,
            createdBy: user.name ?? user.email,
          },
        })

        const updated = await tx.vendorBill.update({
          where: { id },
          data: {
            // amountPaid 由流水汇总而来 —— 不用 increment，避免它与流水各自漂移
            amountPaid: plan.newPaid,
            amountDue: plan.newDue,
            ...(plan.fullyPaid ? { status: 'PAID' as const, paidAt: new Date() } : {}),
          },
        })

        // 凭证幂等键用 payment.id。原实现拼的是 `${billId}-pay-${累计金额}`，
        // 同一账单先付 100 → 冲销 → 再付 100 会撞出同一个 sourceId
        const entry = await postVendorPaymentToJournal(
          tx as never,
          { id: payment.id, billName: bill.name, supplierId: bill.supplierId, amount },
          user.userId,
        )
        return { payment, bill: updated, journalEntry: entry }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'vendor_payment', resourceId: result.payment.id,
        detail: `${result.bill.name} 付款 €${amount.toFixed(2)}（${method}）· 已付 €${toNum(result.bill.amountPaid).toFixed(2)} / 未付 €${toNum(result.bill.amountDue).toFixed(2)}`,
      })
      return NextResponse.json(serializeApi(result), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/vendor-bills/[id]/payments]', error)
      return NextResponse.json({ error: '登记付款失败' }, { status: 500 })
    }
  }, { require: 'finance.vendor_bill.update' })
}
