import { confirmReturnCredit } from '@/lib/return-workflow'
import { createDraftCreditNotesForReturns } from '@/lib/finance/return-credit-note'
import { assertReturnReviewComplete, lockReturnOrders, returnError } from '@/lib/return-invoice-guard'
import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { nextSequenceName } from '@/lib/sequence-number'

/**
 * P0-3: CreditNote — 跨单合并退款单
 *
 * GET  /api/credit-notes          — 列表（支持 ?customerId= 过滤）
 * POST /api/credit-notes          — 创建退款单（可合并多个订单的退货）
 */

interface InboundLine {
  productId: string
  productName: string
  quantity: number
  unitPrice: number
  taxRate?: number
  reason?: string
  sourceOrderId?: string
  sourceTripId?: string
  sequence?: number
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const customerId = searchParams.get('customerId')
    const status = searchParams.get('status')

    const where: Record<string, unknown> = {}
    if (customerId) where.customerId = customerId
    if (status) where.status = status

    const creditNotes = await prisma.creditNote.findMany({
      where,
      include: { lines: { orderBy: { sequence: 'asc' } }, sourceInvoice: { select: { id: true, name: true } } },
      orderBy: { createdAt: 'desc' },
    })
    // 剩余可用 = 总额 − Σ 抵扣/退款（20261014 L1），列表直接显示，不用点进详情
    const sums = creditNotes.length
      ? await prisma.creditNoteAllocation.groupBy({
          by: ['creditNoteId'], where: { creditNoteId: { in: creditNotes.map(c => c.id) } }, _sum: { amount: true },
        })
      : []
    const sourceOrderIds = [...new Set(creditNotes.flatMap(c => c.lines.map(line => line.sourceOrderId).filter((id): id is string => Boolean(id))))]
    const sourceOrders = sourceOrderIds.length ? await prisma.order.findMany({
      where: { id: { in: sourceOrderIds } }, select: { id: true, code: true },
    }) : []
    const orderCodeById = new Map(sourceOrders.map(order => [order.id, order.code]))
    const used = new Map(sums.map(s => [s.creditNoteId, toNum(s._sum.amount ?? 0)]))
    return NextResponse.json(serializeApi(creditNotes.map(c => ({
      ...c,
      lines: c.lines.map(line => ({ ...line, sourceOrderCode: line.sourceOrderId ? orderCodeById.get(line.sourceOrderId) ?? null : null })),
      amountAllocated: round2(used.get(c.id) ?? 0),
      amountRemaining: round2(toNum(c.totalIncTax) - (used.get(c.id) ?? 0)),
    }))))
  } catch (error) {
    console.error('[GET /api/credit-notes]', error)
    return NextResponse.json({ error: '获取退款单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      if (data.action === 'historical_complaint') {
        const orderId = String(data.orderId ?? '').trim()
        const orderLineId = String(data.orderLineId ?? '').trim()
        const complaintId = String(data.complaintId ?? '')
        const reason = String(data.reason ?? '').trim().slice(0, 500)
        const amount = data.creditAmountExTax
        if (!orderId || !orderLineId || !reason || !/^[a-f0-9-]{36}$/i.test(complaintId) || typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0 || amount >= 1e10 || Math.abs(amount - round2(amount)) > 0.000001) {
          returnError('请选择历史订单行并填写投诉原因和有效未税贷记金额', 400)
        }
        const sourceReturnId = `HISTORICAL_COMPLAINT:${complaintId}`
        const credit = await prisma.$transaction(async tx => {
          await lockReturnOrders(tx, [orderId])
          const existing = await tx.creditNoteLine.findUnique({ where: { sourceReturnId }, select: { sourceOrderId: true, sourceOrderLineId: true, creditNote: { select: { id: true, name: true } } } })
          if (existing) {
            if (existing.sourceOrderId !== orderId || existing.sourceOrderLineId !== orderLineId) returnError('此投诉已关联其他订单行')
            return existing.creditNote
          }
          const order = await tx.order.findUnique({ where: { id: orderId }, select: { restaurantId: true, restaurantName: true } })
          const line = await tx.orderLine.findFirst({ where: { id: orderLineId, orderId }, select: { productId: true, productName: true } })
          if (!order || !line) returnError('原订单行不存在', 404)
          await assertReturnReviewComplete(tx, [orderId])
          const invoices = await tx.invoice.findMany({
            where: { saleOrderIds: { has: orderId }, customerId: order.restaurantId, status: { in: ['POSTED', 'PAID'] } },
            select: { id: true, lines: true },
          })
          const matches = invoices.flatMap(invoice => (Array.isArray(invoice.lines) ? invoice.lines : []).flatMap(row =>
            row && typeof row === 'object' && !Array.isArray(row) && row.orderLineId === orderLineId ? [{ invoiceId: invoice.id, taxRate: toNum(row.taxRate) }] : []))
          if (matches.length !== 1) returnError('请先核对该订单行对应的唯一已过账发票')
          const [{ invoiceId, taxRate }] = matches
          const [note] = await createDraftCreditNotesForReturns(tx, [{
            sourceReturnId, sourceOrderId: orderId, sourceOrderLineId: orderLineId, sourceInvoiceId: invoiceId,
            customerId: order.restaurantId, customerName: order.restaurantName, ...line,
            quantity: 1, amountExTax: amount, taxRate: taxRate > 1 ? taxRate / 100 : taxRate, reason,
          }], user.userId)
          if (!note) returnError('无法生成贷记单')
          await confirmReturnCredit(tx, note.id, user.userId)
          return note
        })
        await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'CREATE', resource: 'credit-note', resourceId: credit.id, detail: `历史单客诉贷记 ${credit.name}：${reason}` })
        return NextResponse.json(serializeApi(credit), { status: 201 })
      }
      const customerId = String(data.customerId ?? '').trim()
      const customerName = String(data.customerName ?? '').trim()
      const notes = data.notes ? String(data.notes).trim().slice(0, 1000) : null
      const currency = String(data.currency ?? 'EUR').trim()
      const lines = data.lines as InboundLine[] | undefined

      if (!customerId || !customerName) {
        return NextResponse.json({ error: '缺少客户信息' }, { status: 400 })
      }
      const safeLines = Array.isArray(lines) ? lines : []

      // P0-3: 服务端权威计算金额
      let subtotalExTax = 0
      let totalTax = 0
      const lineData = safeLines.map((l, idx) => {
        const qty = toNum(l.quantity)
        const price = toNum(l.unitPrice)
        const taxRate = toNum(l.taxRate)
        const lineSubtotal = round2(qty * price)
        const lineTax = round2(lineSubtotal * taxRate)
        subtotalExTax += lineSubtotal
        totalTax += lineTax
        return {
          productId: String(l.productId ?? '').trim(),
          productName: String(l.productName ?? '').trim(),
          quantity: qty,
          unitPrice: price,
          taxRate,
          subtotalExTax: lineSubtotal,
          taxAmount: lineTax,
          subtotalIncTax: round2(lineSubtotal + lineTax),
          reason: l.reason ? String(l.reason).trim().slice(0, 500) : null,
          sourceOrderId: l.sourceOrderId ? String(l.sourceOrderId).trim() : null,
          sourceTripId: l.sourceTripId ? String(l.sourceTripId).trim() : null,
          sequence: l.sequence ?? idx,
        }
      })

      const invalidLine = lineData.find(line => !line.productId || !line.productName || !(line.quantity > 0) || line.unitPrice < 0 || line.taxRate < 0)
      if (invalidLine) return NextResponse.json({ error: '商品、数量、单价或税率无效' }, { status: 400 })

      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      // 生成编号 CN-YYYYMMDD-XXXX
      const today = new Date()
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
      // 当天同前缀(CN-日期-)下现有最大号 + 1，不用当天 count+1(删过/有空号就撞号，见 lib/sequence-number.ts)
      const name = await nextSequenceName(prisma, 'CreditNote', `CN-${dateStr}-`, 4)

      const creditNote = await prisma.creditNote.create({
        data: {
          name,
          customerId,
          customerName,
          creditDate: today,
          createdAt: today,
          currency,
          subtotalExTax,
          totalTax,
          totalIncTax,
          status: 'DRAFT',
          notes,
          createdBy: user.userId,
          lines: {
            create: lineData,
          },
        },
        include: { lines: { orderBy: { sequence: 'asc' } } },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'credit-note', resourceId: creditNote.id,
        detail: `创建贷记单 ${name} — ${customerName} — ${lineData.length}行 — €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(creditNote), { status: 201 })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[POST /api/credit-notes]', error)
      return NextResponse.json({ error: '创建退款单失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.create' })
}
