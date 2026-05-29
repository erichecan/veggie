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
      const invoice = await prisma.invoice.update({
        where: { id },
        data: {
          ...data,
          status: data.status?.toUpperCase() ?? undefined,
        },
      })
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
  })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.invoice.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'invoice', resourceId: id,
        detail: `删除发票: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/invoices/[id]]', error)
      return NextResponse.json({ error: '删除发票失败' }, { status: 500 })
    }
  })
}
