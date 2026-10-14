import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postCreditNoteToJournal, postJournalEntry } from '@/lib/accounting'
import { toNum, round2 } from '@/lib/decimal-helpers'
import { suggestInvoicesForCreditNote } from '@/lib/finance/credit-note-allocation'

/**
 * P0-3: CreditNote CRUD — single record
 *
 * GET    /api/credit-notes/:id  — 获取详情
 * PUT    /api/credit-notes/:id  — 更新（仅 DRAFT 状态可改行；任意状态可改 notes/status）
 * DELETE /api/credit-notes/:id  — 删除（仅 DRAFT）
 */

export async function GET(
  _req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const { id } = await params
    const cn = await prisma.creditNote.findUnique({
      where: { id },
      include: {
        lines: { orderBy: { sequence: 'asc' } },
        allocations: { orderBy: { createdAt: 'asc' }, include: { invoice: { select: { id: true, name: true } } } },
      },
    })
    if (!cn) return NextResponse.json({ error: '退款单不存在' }, { status: 404 })
    const used = round2(cn.allocations.reduce((s, a) => s + toNum(a.amount), 0))
    const reversed = new Set(cn.allocations.map(a => a.reversalOfId).filter(Boolean))
    const usable = ['CONFIRMED', 'SETTLED'].includes(String(cn.status))
    const remaining = round2(toNum(cn.totalIncTax) - used)
    return NextResponse.json(serializeApi({
      ...cn,
      allocations: cn.allocations.map(a => ({ ...a, reversed: reversed.has(a.id) })),
      amountAllocated: used,
      amountRemaining: remaining,
      // 可抵扣的发票（同客户、已过账未付清，来源订单对得上的排前面）
      invoiceSuggestions: usable && remaining > 0.005 ? await suggestInvoicesForCreditNote(prisma, id) : [],
    }))
  } catch (error) {
    console.error('[GET /api/credit-notes/[id]]', error)
    return NextResponse.json({ error: '获取退款单详情失败' }, { status: 500 })
  }
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const data = await req.json()

      const existing = await prisma.creditNote.findUnique({
        where: { id },
        include: { lines: true },
      })
      if (!existing) return NextResponse.json({ error: '退款单不存在' }, { status: 404 })

      const updateData: Record<string, unknown> = {}

      // 状态流转：DRAFT → CONFIRMED；CONFIRMED ⇄ SETTLED 由抵扣/退款自动切换（20261014 L1），
      // 不再接受手工「标记已结算」——那样贷项去了哪里没有任何记录，发票余额也不会减
      if (data.status !== undefined) {
        const s = String(data.status).toUpperCase()
        if (s === 'SETTLED') {
          return NextResponse.json({ error: '请用「抵扣发票」或「退款」处理贷记单余额，用完会自动变为已结算' }, { status: 400 })
        }
        const validTransitions: Record<string, string[]> = {
          DRAFT: ['CONFIRMED', 'CANCELLED'],
          CONFIRMED: ['CANCELLED'],
        }
        const allowed = validTransitions[String(existing.status)] ?? []
        if (!allowed.includes(s)) {
          return NextResponse.json(
            { error: `无法从 ${existing.status} 转为 ${s}` },
            { status: 400 },
          )
        }
        updateData.status = s
      }

      if (data.notes !== undefined) {
        updateData.notes = data.notes ? String(data.notes).trim().slice(0, 1000) : null
      }

      // 仅 DRAFT 状态允许修改行项
      if (Array.isArray(data.lines) && String(existing.status) === 'DRAFT') {
        // 删除旧行，重建新行
        await prisma.creditNoteLine.deleteMany({ where: { creditNoteId: id } })

        let subtotalExTax = 0
        let totalTax = 0
        const lineData = (data.lines as Array<{
          productId: string; productName: string
          quantity: number; unitPrice: number; taxRate?: number
          reason?: string; sourceOrderId?: string; sourceTripId?: string
          sequence?: number
        }>).map((l, idx) => {
          const qty = toNum(l.quantity)
          const price = toNum(l.unitPrice)
          const taxRate = toNum(l.taxRate)
          const lineSubtotal = round2(qty * price)
          const lineTax = round2(lineSubtotal * taxRate)
          subtotalExTax += lineSubtotal
          totalTax += lineTax
          return {
            creditNoteId: id,
            productId: String(l.productId).trim(),
            productName: String(l.productName).trim(),
            quantity: qty,
            unitPrice: price,
            taxRate,
            subtotalExTax: lineSubtotal,
            taxAmount: lineTax,
            subtotalIncTax: round2(lineSubtotal + lineTax),
            reason: l.reason ? String(l.reason).trim().slice(0, 500) : null,
            sourceOrderId: l.sourceOrderId || null,
            sourceTripId: l.sourceTripId || null,
            sequence: l.sequence ?? idx,
          }
        })

        await prisma.creditNoteLine.createMany({ data: lineData })
        updateData.subtotalExTax = round2(subtotalExTax)
        updateData.totalTax = round2(totalTax)
        updateData.totalIncTax = round2(subtotalExTax + totalTax)
      }

      if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
      }

      updateData.updatedAt = new Date()
      // SSOT: 确认贷记单时生成总账凭证 Dr Revenue+VAT / Cr AR(此前 CreditNote 游离总账 — P1-6)
      const willConfirm = updateData.status === 'CONFIRMED'
      // 已确认的贷记单作废：确认时出过 Cr AR 凭证，作废要反向冲回（20261014 L1 补；此前作废后总账应收仍被多冲）。
      // 已经抵扣/退款过的不能直接作废——先撤销那些抵扣，否则发票余额和退款凭证都悬空。
      const willVoidConfirmed = updateData.status === 'CANCELLED' && String(existing.status) === 'CONFIRMED'
      if (willVoidConfirmed) {
        const used = await prisma.creditNoteAllocation.aggregate({ where: { creditNoteId: id }, _sum: { amount: true } })
        if (Math.abs(toNum(used._sum.amount ?? 0)) > 0.005) {
          return NextResponse.json({ error: '这张贷记单已经抵扣过发票或退过款，请先撤销那些记录再作废' }, { status: 400 })
        }
      }
      const updated = await prisma.$transaction(async (tx) => {
        const u = await tx.creditNote.update({
          where: { id },
          data: updateData,
          include: { lines: { orderBy: { sequence: 'asc' } } },
        })
        if (willConfirm) {
          await postCreditNoteToJournal(
            tx as never,
            { id: u.id, name: u.name, customerId: u.customerId, subtotalExTax: u.subtotalExTax, totalTax: u.totalTax, totalIncTax: u.totalIncTax },
            user.userId,
          )
        }
        if (willVoidConfirmed) {
          const sub = toNum(u.subtotalExTax), tax = toNum(u.totalTax), total = toNum(u.totalIncTax)
          await postJournalEntry(tx, {
            narration: `Credit Note ${u.name} cancelled`,
            sourceType: 'credit_note_void',
            sourceId: u.id,
            lines: [
              { code: '1100', debit: total, description: `AR credit reversal - ${u.name}`, partnerId: u.customerId },
              { code: '4000', credit: sub, description: `Sales return reversal - ${u.name}` },
              ...(tax > 0 ? [{ code: '2200', credit: tax, description: `VAT reversal - ${u.name}` }] : []),
            ],
          }, user.userId)
        }
        return u
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'credit-note', resourceId: id,
        detail: `更新退款单 ${existing.name}: ${Object.keys(updateData).join(', ')}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/credit-notes/[id]]', error)
      return NextResponse.json({ error: '更新退款单失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.update' })
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const existing = await prisma.creditNote.findUnique({ where: { id } })
      if (!existing) return NextResponse.json({ error: '退款单不存在' }, { status: 404 })
      if (String(existing.status) !== 'DRAFT') {
        return NextResponse.json({ error: '仅 DRAFT 状态可删除' }, { status: 400 })
      }

      await prisma.creditNote.delete({ where: { id } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'credit-note', resourceId: id,
        detail: `删除退款单 ${existing.name}`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/credit-notes/[id]]', error)
      return NextResponse.json({ error: '删除退款单失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.delete' })
}
