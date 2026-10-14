import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { reverseCreditNoteAllocation } from '@/lib/finance/credit-note-allocation'

/** POST /api/credit-notes/:id/allocations/:allocationId/reverse —— 撤销一笔抵扣/退款（追加负数冲正行，不删原行） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string; allocationId: string }> }) {
  const { id, allocationId } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json().catch(() => ({}))
      const own = await prisma.creditNoteAllocation.findUnique({ where: { id: allocationId }, select: { creditNoteId: true } })
      if (!own || own.creditNoteId !== id) return NextResponse.json({ error: '抵扣记录不存在' }, { status: 404 })
      const r = await prisma.$transaction(tx => reverseCreditNoteAllocation(tx, {
        allocationId,
        note: data?.note ? String(data.note).trim().slice(0, 500) : null,
        actor: { userId: user.userId, name: user.name, email: user.email },
      }))
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'credit-note', resourceId: id,
        detail: `${r.creditNoteName} 撤销${r.reversal.kind === 'REFUND' ? '退款' : '抵扣'} €${Math.abs(Number(r.reversal.amount)).toFixed(2)}`,
      })
      return NextResponse.json(serializeApi(r), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message }, { status: err.status })
      }
      console.error('[POST /api/credit-notes/[id]/allocations/[allocationId]/reverse]', error)
      return NextResponse.json({ error: '撤销失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.update' })
}
