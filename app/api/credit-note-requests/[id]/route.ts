import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { nextSequenceName } from '@/lib/sequence-number'
import { round2, toNum } from '@/lib/decimal-helpers'
import { writeLog } from '@/lib/action-log'

type RequestLine = { orderLineId?: string; sourceReturnId?: string; productId: string; productName: string; quantity: number; unitPrice: number; taxRate: number; discountAmount: number; subtotalExTax: number; taxAmount: number; subtotalIncTax: number; reason: string }

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    try {
      const { id } = await params
      const body = await req.json() as { action?: 'approve' | 'reject'; reviewNote?: string }
      if (!['approve', 'reject'].includes(String(body.action))) return NextResponse.json({ error: '请选择批准或拒绝' }, { status: 400 })
      if (body.action === 'reject' && !String(body.reviewNote ?? '').trim()) return NextResponse.json({ error: '拒绝申请时请填写原因' }, { status: 400 })
      const result = await prisma.$transaction(async tx => {
        const request = await tx.creditNoteRequest.findUnique({ where: { id } })
        if (!request) throw Object.assign(new Error('申请不存在'), { status: 404 })
        if (request.status !== 'PENDING') throw Object.assign(new Error('该申请已处理'), { status: 409 })
        if (body.action === 'reject') {
          const updated = await tx.creditNoteRequest.update({ where: { id }, data: {
            status: 'REJECTED', reviewedById: user.userId, reviewedByName: user.name,
            reviewedAt: new Date(), reviewNote: String(body.reviewNote ?? '').trim() || null,
          } })
          return { request: updated, creditNote: null }
        }

        const lines = Array.isArray(request.lines) ? request.lines as unknown as RequestLine[] : []
        if (!lines.length || toNum(request.totalIncTax) <= 0) throw Object.assign(new Error('申请没有有效金额明细'), { status: 409 })
        const now = new Date()
        const prefix = `CN-${now.toISOString().slice(0, 10).replace(/-/g, '')}-`
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
        const name = await nextSequenceName(tx, 'CreditNote', prefix, 4)
        const sourceInvoice = request.sourceInvoiceId ? await tx.invoice.findFirst({
          where: { id: request.sourceInvoiceId, status: { in: ['POSTED', 'PAID'] } },
          select: { id: true },
        }) : null
        const invoices = request.sourceInvoiceId ? [] : await tx.invoice.findMany({
          where: { saleOrderIds: { has: request.sourceOrderId }, status: { in: ['POSTED', 'PAID'] } },
          orderBy: { createdAt: 'desc' }, select: { id: true, lines: true },
        })
        const requestedLineIds = new Set(lines.map(line => line.orderLineId).filter((id): id is string => Boolean(id)))
        const matchedInvoice = invoices.find(invoice => {
          const invoiceLines = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
          const invoicedLineIds = new Set(invoiceLines.map(line => String(line.orderLineId ?? '')).filter(Boolean))
          return requestedLineIds.size > 0 && [...requestedLineIds].every(lineId => invoicedLineIds.has(lineId))
        })
        const sourceInvoiceId = sourceInvoice?.id ?? matchedInvoice?.id ?? null
        const subtotalExTax = round2(lines.reduce((sum, line) => sum + toNum(line.subtotalExTax), 0))
        const totalTax = round2(lines.reduce((sum, line) => sum + toNum(line.taxAmount), 0))
        const note = await tx.creditNote.create({
          data: {
            name, customerId: request.customerId, customerName: request.customerName,
            creditDate: request.requestDate, currency: 'EUR', subtotalExTax, totalTax,
            totalIncTax: round2(subtotalExTax + totalTax), status: 'DRAFT',
            sourceInvoiceId, createdBy: user.userId,
            notes: `销售申请 ${request.name}：${request.reason}`,
            lines: { create: lines.map((line, sequence) => ({
              productId: line.productId, productName: line.productName, quantity: line.quantity,
              sourceOrderLineId: line.orderLineId ?? null,
              sourceReturnId: line.sourceReturnId ?? null,
              unitPrice: round2(toNum(line.subtotalExTax) / Math.max(toNum(line.quantity), 0.001)),
              taxRate: toNum(line.taxRate), subtotalExTax: round2(toNum(line.subtotalExTax)),
              taxAmount: round2(toNum(line.taxAmount)), subtotalIncTax: round2(toNum(line.subtotalIncTax)),
              reason: line.reason || request.reason, sourceOrderId: request.sourceOrderId, sequence,
            })) },
          },
        })
        const updated = await tx.creditNoteRequest.update({ where: { id }, data: {
          status: 'APPROVED', reviewedById: user.userId, reviewedByName: user.name,
          reviewedAt: now, reviewNote: String(body.reviewNote ?? '').trim() || null,
          creditNoteId: note.id,
        } })
        return { request: updated, creditNote: note }
      })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'UPDATE', resource: 'credit-note-request', resourceId: id, detail: body.action === 'approve' ? `批准贷记申请并生成草稿 ${result.creditNote?.name}` : `拒绝贷记申请 ${result.request.name}` })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500
      if (status === 500) console.error('[PUT /api/credit-note-requests/[id]]', error)
      return NextResponse.json({ error: error instanceof Error ? error.message : '处理申请失败' }, { status })
    }
  }, { require: 'finance.credit_note.create' })
}
