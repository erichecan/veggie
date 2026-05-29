import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * /api/vendor-bills
 * ============================================================================
 * 供应商账单（Odoo account.move type=in_invoice）。
 *
 * 工作流：
 *   DRAFT → POSTED（对账确认）→ PAID（付款后）
 *   * → CANCELLED
 *
 * POST body:
 *   { purchaseOrderId?, supplierId, billDate, dueDate?, lines: [{ productId, productName, qty, unitCost, taxRate }] }
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const supplierId = searchParams.get('supplierId')
    const status = searchParams.get('status')?.toUpperCase()
    const where: Record<string, unknown> = {}
    if (supplierId) where.supplierId = supplierId
    if (status) where.status = status

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const rows = await p.vendorBill.findMany({
      where,
      orderBy: { billDate: 'desc' },
      take: 500,
    })
    return NextResponse.json(serializeApi(rows))
  } catch (error) {
    console.error('[GET /api/vendor-bills]', error)
    return NextResponse.json({ error: '获取账单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const supplierId = String(data.supplierId ?? '').trim()
      if (!supplierId) return NextResponse.json({ error: 'supplierId 必填' }, { status: 400 })
      const rawLines = Array.isArray(data.lines) ? data.lines : []
      if (rawLines.length === 0) return NextResponse.json({ error: '账单行不能为空' }, { status: 400 })

      let subtotalExTax = 0
      let totalTax = 0
      const recomputed = rawLines.map((raw: Record<string, unknown>) => {
        const qty = Number(raw.qty ?? raw.quantity ?? 0)
        const unit = Number(raw.unitCost ?? raw.unitPrice ?? 0)
        const rate = Number(raw.taxRate ?? 0)
        if (!Number.isFinite(qty) || qty <= 0) {
          throw Object.assign(new Error(`账单行数量无效`), { status: 400 })
        }
        if (!Number.isFinite(unit) || unit < 0) {
          throw Object.assign(new Error(`账单行单价无效`), { status: 400 })
        }
        const ex = round2(qty * unit)
        const tax = round2(ex * rate)
        const inc = round2(ex + tax)
        subtotalExTax += ex
        totalTax += tax
        return {
          productId: String(raw.productId ?? ''),
          productName: String(raw.productName ?? '').trim().slice(0, 200),
          qty, unitCost: unit, taxRate: rate,
          subtotalExTax: ex, taxAmount: tax, subtotalIncTax: inc,
        }
      })
      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const count = await p.vendorBill.count()
      const name = `VB-${String(count + 1).padStart(5, '0')}`

      const bill = await p.vendorBill.create({
        data: {
          name,
          purchaseOrderId: data.purchaseOrderId ?? null,
          supplierId,
          billDate: data.billDate ? new Date(data.billDate) : new Date(),
          dueDate: data.dueDate ? new Date(data.dueDate) : null,
          lines: recomputed,
          subtotalExTax, totalTax, totalIncTax,
          amountPaid: 0, amountDue: totalIncTax,
          status: 'DRAFT',
          notes: data.notes ?? null,
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'vendor_bill', resourceId: bill.id,
        detail: `创建供应商账单 ${name}, 金额 €${totalIncTax}`,
      })
      return NextResponse.json(serializeApi(bill), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/vendor-bills]', error)
      return NextResponse.json({ error: '创建账单失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
