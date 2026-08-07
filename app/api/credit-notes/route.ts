import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { toNum, round2 } from '@/lib/decimal-helpers'

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
      include: { lines: { orderBy: { sequence: 'asc' } } },
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json(serializeApi(creditNotes))
  } catch (error) {
    console.error('[GET /api/credit-notes]', error)
    return NextResponse.json({ error: '获取退款单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const customerId = String(data.customerId ?? '').trim()
      const customerName = String(data.customerName ?? '').trim()
      const notes = data.notes ? String(data.notes).trim().slice(0, 1000) : null
      const currency = String(data.currency ?? 'EUR').trim()
      const lines = data.lines as InboundLine[] | undefined

      if (!customerId || !customerName) {
        return NextResponse.json({ error: '缺少客户信息' }, { status: 400 })
      }
      if (!Array.isArray(lines) || lines.length === 0) {
        return NextResponse.json({ error: '至少需要一行退款明细' }, { status: 400 })
      }

      // P0-3: 服务端权威计算金额
      let subtotalExTax = 0
      let totalTax = 0
      const lineData = lines.map((l, idx) => {
        const qty = toNum(l.quantity)
        const price = toNum(l.unitPrice)
        const taxRate = toNum(l.taxRate)
        const lineSubtotal = round2(qty * price)
        const lineTax = round2(lineSubtotal * taxRate)
        subtotalExTax += lineSubtotal
        totalTax += lineTax
        return {
          productId: String(l.productId).trim(),
          productName: String(l.productName).trim(),
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

      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      // 生成编号 CN-YYYYMMDD-XXXX
      const today = new Date()
      const dateStr = today.toISOString().slice(0, 10).replace(/-/g, '')
      const count = await prisma.creditNote.count({
        where: {
          createdAt: {
            gte: new Date(today.getFullYear(), today.getMonth(), today.getDate()),
          },
        },
      })
      const name = `CN-${dateStr}-${String(count + 1).padStart(4, '0')}`

      const creditNote = await prisma.creditNote.create({
        data: {
          name,
          customerId,
          customerName,
          creditDate: today,
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
        detail: `创建退款单 ${name} — ${customerName} — ${lines.length}行 — €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(creditNote), { status: 201 })
    } catch (error) {
      console.error('[POST /api/credit-notes]', error)
      return NextResponse.json({ error: '创建退款单失败' }, { status: 500 })
    }
  }, { require: 'finance.credit_note.create' })
}
