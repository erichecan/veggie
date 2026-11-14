import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { nextSequenceName } from '@/lib/sequence-number'
import { round2, toNum } from '@/lib/decimal-helpers'

/** Create an editable draft credit note from a posted invoice, independent of returns. */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    const { id } = await params
    try {
      const created = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`
        const invoice = await tx.invoice.findUnique({ where: { id } })
        if (!invoice) throw Object.assign(new Error('发票不存在'), { status: 404 })
        if (!['POSTED', 'PAID'].includes(String(invoice.status))) {
          throw Object.assign(new Error('只有已过账或已付款的发票可以创建贷记单'), { status: 409 })
        }

        const date = new Date()
        const prefix = `CN-${date.toISOString().slice(0, 10).replace(/-/g, '')}-`
        await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtext(${prefix}))`
        const name = await nextSequenceName(tx, 'CreditNote', prefix, 4)
        const rawLines = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
        const hasProductLines = rawLines.some(line => line.productId != null || line.productName != null)

        let lineData: Array<Record<string, unknown>>
        if (hasProductLines) {
          lineData = rawLines.map((line, sequence) => {
            if (line.productId == null && line.productName == null && (line.orderCode != null || line.orderId != null)) {
              const amount = toNum(line.amount)
              if (amount < 0) throw Object.assign(new Error(`发票明细第 ${sequence + 1} 行金额无效`), { status: 409 })
              return {
                productId: `invoice-order:${String(line.orderId ?? invoice.id)}:${sequence + 1}`,
                productName: String(line.orderCode ?? invoice.name),
                quantity: 1,
                unitPrice: amount,
                taxRate: 0,
                subtotalExTax: amount,
                taxAmount: 0,
                subtotalIncTax: amount,
                reason: `Credit from invoice ${invoice.name}`,
                sourceOrderId: line.orderId ? String(line.orderId) : null,
                sequence,
              }
            }
            const quantity = toNum(line.qty ?? line.quantity ?? 1)
            const unitPrice = toNum(line.unitPrice)
            const taxRate = toNum(line.taxRate)
            if (!(quantity > 0) || unitPrice < 0 || taxRate < 0) {
              throw Object.assign(new Error(`发票明细第 ${sequence + 1} 行数据无效`), { status: 409 })
            }
            const subtotalExTax = round2(quantity * unitPrice)
            const taxAmount = round2(subtotalExTax * taxRate)
            return {
              productId: String(line.productId ?? `invoice-line:${invoice.id}:${sequence + 1}`),
              productName: String(line.productName ?? invoice.name),
              quantity,
              unitPrice,
              taxRate,
              subtotalExTax,
              taxAmount,
              subtotalIncTax: round2(subtotalExTax + taxAmount),
              reason: `Credit from invoice ${invoice.name}`,
              sourceOrderId: invoice.saleOrderIds.length === 1 ? invoice.saleOrderIds[0] : null,
              sequence,
            }
          })
        } else {
          // Legacy Odoo invoices contain order-level amounts instead of product lines.
          // Keep the exact invoice totals in one clearly labelled, editable line.
          const subtotalExTax = toNum(invoice.subtotalExTax)
          const totalTax = toNum(invoice.totalTax)
          const totalIncTax = toNum(invoice.totalIncTax)
          if (!(totalIncTax > 0)) throw Object.assign(new Error('这张发票没有可用于贷记单的金额明细'), { status: 409 })
          lineData = [{
            productId: `invoice:${invoice.id}`,
            productName: `Credit from ${invoice.name}`,
            quantity: 1,
            unitPrice: subtotalExTax,
            taxRate: subtotalExTax > 0 ? totalTax / subtotalExTax : 0,
            subtotalExTax,
            taxAmount: totalTax,
            subtotalIncTax: totalIncTax,
            reason: `Credit from invoice ${invoice.name} (legacy order-level invoice)`,
            sourceOrderId: invoice.saleOrderIds.length === 1 ? invoice.saleOrderIds[0] : null,
            sequence: 0,
          }]
        }

        const subtotalExTax = round2(lineData.reduce((sum, line) => sum + toNum(line.subtotalExTax), 0))
        const totalTax = round2(lineData.reduce((sum, line) => sum + toNum(line.taxAmount), 0))
        const totalIncTax = round2(subtotalExTax + totalTax)
        if (!(totalIncTax > 0)) throw Object.assign(new Error('贷记单金额必须大于 0'), { status: 409 })

        return tx.creditNote.create({
          data: {
            name,
            customerId: invoice.customerId,
            customerName: invoice.customerName,
            creditDate: date,
            currency: 'EUR',
            subtotalExTax,
            totalTax,
            totalIncTax,
            status: 'DRAFT',
            notes: `Draft created from invoice ${invoice.name}; review and edit before confirming.`,
            createdBy: user.userId,
            sourceInvoiceId: invoice.id,
            lines: { create: lineData as never },
          },
          include: { lines: { orderBy: { sequence: 'asc' } }, sourceInvoice: { select: { id: true, name: true } } },
        })
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'credit-note', resourceId: created.id,
        detail: `从发票 ${created.sourceInvoice?.name ?? id} 创建贷记单草稿 ${created.name} — ${created.customerName} — €${toNum(created.totalIncTax).toFixed(2)}`,
      })
      return NextResponse.json(serializeApi(created), { status: 201 })
    } catch (error) {
      const status = Number((error as { status?: number })?.status) || 500
      if (status === 500) console.error('[POST /api/invoices/[id]/credit-note]', error)
      return NextResponse.json({ error: error instanceof Error && status !== 500 ? error.message : '创建贷记单失败' }, { status })
    }
  }, { require: 'finance.credit_note.create' })
}
