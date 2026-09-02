import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum } from '@/lib/decimal-helpers'
import { orderIncTaxTotal } from '@/lib/order-items'
import { addBusinessDays } from '@/lib/analytics/metrics'
import { reconcileStatement, paymentSource, paymentTripId } from '@/lib/finance/statement'

/**
 * P1-1: 对账单单条操作
 *
 * GET    /api/statements/:id  — 查详情
 * PUT    /api/statements/:id  — 更新状态（draft→confirmed→sent）
 * DELETE /api/statements/:id  — 删除（仅 draft 可删）
 */

/**
 * GET /api/statements/:id?withDetail=1
 * ----------------------------------------------------------------------------
 * 验收要求「金额与订单明细可逐笔对上」。`withDetail=1` 返回：
 *   orders        —— 按**存下来的 orderIds**取（对账单是快照，不重新按期间查，
 *                    否则事后新确认的单会凭空出现在一张已发出的账上）
 *   payments      —— 期内收款流水，标出每笔是司机现金还是手工登记
 *   reconciliation—— 当场算出的三个差额。人肉比对是查不出 3 分钱差的
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      const item = await prisma.statement.findUnique({ where: { id } })
      if (!item) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }
      if (new URL(req.url).searchParams.get('withDetail') !== '1') {
        return NextResponse.json(serializeApi(item))
      }

      const period = { start: item.periodStart, endExclusive: addBusinessDays(item.periodEnd, 1) }
      const [orderRows, paymentRows] = await Promise.all([
        prisma.order.findMany({
          where: { id: { in: item.orderIds } },
          orderBy: { confirmationDate: 'asc' },
          select: {
            id: true, code: true, status: true, confirmationDate: true, deliveryDate: true,
            lines: { select: { subtotal: true, taxRate: true } },
          },
        }),
        prisma.payment.findMany({
          where: { customerId: item.customerId, paidAt: { gte: period.start, lt: period.endExclusive } },
          orderBy: { paidAt: 'asc' },
          select: { id: true, invoiceId: true, amount: true, method: true, paidAt: true, note: true, createdBy: true },
        }),
      ])

      const paymentInvoiceIds = [...new Set(paymentRows.map(p => p.invoiceId).filter((id): id is string => id != null))]
      const invoiceNames = paymentInvoiceIds.length > 0
        ? await prisma.invoice.findMany({
            where: { id: { in: paymentInvoiceIds } },
            select: { id: true, name: true, totalIncTax: true, amountDue: true, status: true },
          })
        : []
      const invoiceById = new Map(invoiceNames.map(i => [i.id, i]))

      const orders = orderRows.map(o => ({
        id: o.id, code: o.code, status: o.status,
        confirmationDate: o.confirmationDate, deliveryDate: o.deliveryDate,
        incTaxTotal: orderIncTaxTotal(o.lines),
      }))
      const payments = paymentRows.map(p => {
        const inv = p.invoiceId ? invoiceById.get(p.invoiceId) : undefined
        return {
          id: p.id, invoiceId: p.invoiceId, invoiceName: inv?.name ?? null,
          invoiceStatus: inv?.status ?? null,
          amount: toNum(p.amount), method: p.method, paidAt: p.paidAt,
          note: p.note, createdBy: p.createdBy,
          source: paymentSource(p.note), tripId: paymentTripId(p.note),
        }
      })

      const reconciliation = reconcileStatement({
        stored: {
          openingBalance: toNum(item.openingBalance),
          totalSales: toNum(item.totalSales),
          totalPayments: toNum(item.totalPayments),
          closingBalance: toNum(item.closingBalance),
        },
        orders,
        payments,
      })

      // 「缺笔」比「差额」更难发现：对账单存了 N 个订单 id，若其中几单被删了，
      // 金额差额可能恰好被别的改动抵消，但明细条数对不上是硬伤
      const missingOrders = item.orderIds.filter(oid => !orderRows.some(o => o.id === oid))

      return NextResponse.json(serializeApi({
        ...item, orders, payments, reconciliation, missingOrderIds: missingOrders,
      }))
    } catch (error) {
      console.error('[GET /api/statements/[id]]', error)
      return NextResponse.json({ error: '获取对账单详情失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.read' })
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const existing = await prisma.statement.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }

      const { status } = body

      // 状态转换验证
      const validTransitions: Record<string, string[]> = {
        draft:     ['confirmed'],
        confirmed: ['sent', 'draft'],   // confirmed 可退回 draft 重新编辑
        sent:      [],                   // sent 后不可变更
      }

      if (status && !validTransitions[existing.status]?.includes(status)) {
        return NextResponse.json(
          { error: `不能从 ${existing.status} 转换到 ${status}` },
          { status: 400 },
        )
      }

      const updateData: Record<string, unknown> = {}
      if (status) {
        updateData.status = status
        if (status === 'sent') {
          updateData.sentAt = new Date()
        }
      }

      const updated = await prisma.statement.update({
        where: { id },
        data: updateData,
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'statement', resourceId: id,
        detail: `更新对账单: 状态→${status}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/statements/[id]]', error)
      return NextResponse.json({ error: '更新对账单失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.update' })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const existing = await prisma.statement.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }

      if (existing.status !== 'draft') {
        return NextResponse.json(
          { error: '只能删除 draft 状态的对账单' },
          { status: 400 },
        )
      }

      await prisma.statement.delete({ where: { id } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'statement', resourceId: id,
        detail: `删除对账单: ${existing.customerName} ${existing.periodStart.toISOString().slice(0, 10)}~${existing.periodEnd.toISOString().slice(0, 10)}`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/statements/[id]]', error)
      return NextResponse.json({ error: '删除对账单失败' }, { status: 500 })
    }
  }, { require: 'finance.statement.delete' })
}
