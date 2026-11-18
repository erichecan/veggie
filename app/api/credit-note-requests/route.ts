import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { isRowVisible, salesRowScope } from '@/lib/row-scope'
import { serializeApi } from '@/lib/api-serializer'
import { nextSequenceName } from '@/lib/sequence-number'
import { round2, toNum } from '@/lib/decimal-helpers'
import { writeLog } from '@/lib/action-log'

type RequestLineInput = { orderLineId: string; quantity: number; discountAmount?: number; reason?: string }

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const rows = await prisma.creditNoteRequest.findMany({
        orderBy: { createdAt: 'desc' }, take: 500,
      })
      return NextResponse.json(serializeApi(rows))
    } catch (error) {
      console.error('[GET /api/credit-note-requests]', error)
      return NextResponse.json({ error: '获取贷记申请失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.read' })
}

// Avoid coupling creation of a Sales request to the accounting CN permission.
export async function POST(req: Request) {
  return withAuth(req, async user => {
    try {
      const body = await req.json() as { orderId?: string; reason?: string; lines?: RequestLineInput[] }
      const orderId = String(body.orderId ?? '')
      const reason = String(body.reason ?? '').trim()
      if (!orderId || !reason || !Array.isArray(body.lines) || !body.lines.length) {
        return NextResponse.json({ error: '请选择订单、填写申请原因并至少添加一项商品' }, { status: 400 })
      }
      const order = await prisma.order.findUnique({
        where: { id: orderId },
        include: {
          lines: { orderBy: { sequence: 'asc' } },
          salesUser: { select: { id: true, managerId: true } },
        },
      })
      if (!order) return NextResponse.json({ error: '销售订单不存在' }, { status: 404 })
      if (!isRowVisible(order, salesRowScope(user), row => (row as { createdById?: string | null }).createdById === user.userId)) {
        return NextResponse.json({ error: '销售订单不存在' }, { status: 404 })
      }
      if (!order.restaurantId || !order.restaurantName) return NextResponse.json({ error: '订单缺少客户信息，无法提交贷记申请' }, { status: 409 })
      let total = 0
      const lines = body.lines.map((input, index) => {
        const source = order.lines.find(line => line.id === input.orderLineId)
        const quantity = toNum(input.quantity)
        const discountAmount = round2(toNum(input.discountAmount))
        if (!source || quantity <= 0 || quantity > toNum(source.orderedQty) || discountAmount < 0) throw Object.assign(new Error(`第 ${index + 1} 行商品或数量无效`), { status: 400 })
        const gross = round2(quantity * toNum(source.unitPrice))
        if (discountAmount > gross) throw Object.assign(new Error(`第 ${index + 1} 行折扣不能大于商品金额`), { status: 400 })
        const rawTaxRate = toNum(source.taxRate)
        const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate
        const subtotalExTax = round2(gross - discountAmount)
        const taxAmount = round2(subtotalExTax * taxRate)
        const subtotalIncTax = round2(subtotalExTax + taxAmount)
        total += subtotalIncTax
        return {
          orderLineId: source.id, productId: source.productId, productName: source.productName,
          quantity, unitPrice: toNum(source.unitPrice), taxRate, discountAmount,
          subtotalExTax, taxAmount, subtotalIncTax,
          reason: String(input.reason ?? '').trim() || reason,
        }
      })
      const requestedQuantities = new Map<string, number>()
      for (const line of lines) requestedQuantities.set(line.orderLineId, (requestedQuantities.get(line.orderLineId) ?? 0) + line.quantity)
      for (const [lineId, quantity] of requestedQuantities) {
        const source = order.lines.find(line => line.id === lineId)
        if (!source || quantity > toNum(source.orderedQty)) throw Object.assign(new Error('同一商品的申请数量不能超过订单数量'), { status: 400 })
      }
      const now = new Date()
      const prefix = `CNR-${now.toISOString().slice(0, 10).replace(/-/g, '')}-`
      const postedInvoices = await prisma.invoice.findMany({
        where: { saleOrderIds: { has: order.id }, status: { in: ['POSTED', 'PAID'] } },
        orderBy: { createdAt: 'desc' }, select: { id: true, lines: true },
      })
      const requestedLineIds = new Set(lines.map(line => line.orderLineId))
      const postedInvoice = postedInvoices.find(invoice => {
        const invoiceLines = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
        const invoicedLineIds = new Set(invoiceLines.map(line => String(line.orderLineId ?? '')).filter(Boolean))
        return [...requestedLineIds].every(lineId => invoicedLineIds.has(lineId))
      })
      const created = await prisma.$transaction(async tx => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
        const name = await nextSequenceName(tx, 'CreditNoteRequest', prefix, 4)
        return tx.creditNoteRequest.create({
          data: {
            name, customerId: order.restaurantId, customerName: order.restaurantName,
            sourceOrderId: order.id, sourceOrderCode: order.code ?? order.id, requestDate: now, reason, lines: lines as never,
            sourceInvoiceId: postedInvoice?.id ?? null,
            totalIncTax: round2(total), status: 'PENDING',
            requestedById: user.userId, requestedByName: user.name,
          },
        })
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'CREATE', resource: 'credit-note-request', resourceId: created.id, detail: `提交贷记申请 ${created.name} — ${order.restaurantName} — ${order.code}` })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500
      if (status === 500) console.error('[POST /api/credit-note-requests]', error)
      return NextResponse.json({ error: error instanceof Error ? error.message : '提交贷记申请失败' }, { status })
    }
  }, { require: 'sales.order.update' })
}

