import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

const INVOICE_TRACKED_FIELDS = [
  'name', 'status', 'customerName', 'subtotalExTax', 'totalTax', 'totalIncTax',
  'amountDue', 'paymentTerms', 'dueDate', 'postedAt',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const invoice = await prisma.invoice.findUnique({ where: { id } })
    if (!invoice) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(invoice))
  } catch (error) {
    console.error('[GET /api/invoices/[id]]', error)
    return NextResponse.json({ error: '获取发票失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const before = await prisma.invoice.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      // SSOT: amountPaid 派生自 Payment 流水,禁止经此 PUT 旁路篡改(P1-6)。
      // 只接受白名单字段;amountDue 仅由 totalIncTax 与现有 amountPaid 重算,不收客户端值。
      const ALLOWED = ['name', 'customerName', 'paymentTerms', 'dueDate', 'subtotalExTax', 'totalTax', 'totalIncTax']
      const updateData: Record<string, unknown> = {}
      for (const k of ALLOWED) if (data[k] !== undefined) updateData[k] = data[k]
      if (data.totalIncTax !== undefined) {
        updateData.amountDue = Math.max(0, Number(data.totalIncTax) - Number(before.amountPaid))
      }
      // 状态流转:过账走 /post(生成凭证+回写 invoicedQty)、收款走 /payments;
      // 本接口只允许取消(CANCELLED),不接受 POSTED/PAID,避免绕过凭证生成(P1-6)。
      if (data.status !== undefined) {
        const s = String(data.status).toUpperCase()
        if (s !== 'CANCELLED') {
          return NextResponse.json({ error: '过账请用确认(Post)操作、收款请用收款操作,不可经此接口直接改状态' }, { status: 400 })
        }
        if (!['DRAFT', 'POSTED'].includes(String(before.status))) {
          return NextResponse.json({ error: `${before.status} 状态不可取消` }, { status: 400 })
        }
        updateData.status = 'CANCELLED'
      }
      const invoice = await prisma.invoice.update({ where: { id }, data: updateData })
      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        invoice as unknown as Record<string, unknown>,
        INVOICE_TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'invoice', resourceId: id,
        detail: `更新发票: ${id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(invoice))
    } catch (error) {
      console.error('[PUT /api/invoices/[id]]', error)
      return NextResponse.json({ error: '更新发票失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      // SSOT: 已过账/已收款的发票有总账凭证且影响 AR,删除会留下悬挂凭证。
      // 只允许删 DRAFT/CANCELLED;已过账的请走取消(Cancelled)(P1-6)。
      const existing = await prisma.invoice.findUnique({ where: { id }, select: { status: true } })
      if (!existing) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      if (!['DRAFT', 'CANCELLED'].includes(String(existing.status))) {
        return NextResponse.json({ error: `${existing.status} 状态的发票不可删除,请改用取消(Cancelled)` }, { status: 400 })
      }
      await prisma.invoice.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'invoice', resourceId: id,
        detail: `删除发票: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/invoices/[id]]', error)
      return NextResponse.json({ error: '删除发票失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
