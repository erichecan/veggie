import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postCreditNoteToJournal } from '@/lib/accounting'
import { toNum, round2 } from '@/lib/decimal-helpers'

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
      include: { lines: { orderBy: { sequence: 'asc' } } },
    })
    if (!cn) return NextResponse.json({ error: '退款单不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(cn))
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

      // 状态流转：DRAFT → CONFIRMED → SETTLED
      if (data.status !== undefined) {
        const s = String(data.status).toUpperCase()
        const validTransitions: Record<string, string[]> = {
          DRAFT: ['CONFIRMED', 'CANCELLED'],
          CONFIRMED: ['SETTLED', 'CANCELLED'],
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
