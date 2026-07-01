import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const customerId = searchParams.get('customerId')
    // ?slim=1 → only id + saleOrderIds (used by orders/quotations pages to detect invoiced orders)
    const slim = searchParams.get('slim') === '1'

    if (slim) {
      const invoices = await prisma.invoice.findMany({
        where: customerId ? { customerId } : undefined,
        select: { id: true, saleOrderIds: true },
        orderBy: { createdAt: 'desc' },
      })
      return NextResponse.json(serializeApi(invoices))
    }

    const invoices = await prisma.invoice.findMany({
      where: customerId ? { customerId } : undefined,
      orderBy: { createdAt: 'desc' },
    })
    return NextResponse.json(serializeApi(invoices))
  } catch (error) {
    console.error('[GET /api/invoices]', error)
    return NextResponse.json({ error: '获取发票失败' }, { status: 500 })
  }
}

/**
 * POST /api/invoices
 * ── 商业级修复 ─────────────────────────────────────────────────────────
 * 1. 服务端重算金额：subtotalExTax / totalTax / totalIncTax / amountDue 由后端根据 lines 权威计算
 *    前端传入金额仅作参考；与服务端偏差 > €0.01 按服务端为准
 * 2. 事务：发票创建 + 源订单状态更新（saleOrderIds → 该订单的 invoice 外链信息）作为原子事务
 * 3. amountPaid 默认 0；amountDue = totalIncTax
 */
function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface InboundLine {
  productId?: string
  productName?: string
  spec?: string
  qty?: number
  quantity?: number
  unitPrice?: number
  taxRate?: number
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()

      const name = String(data.name ?? '').trim().slice(0, 100)
      const customerId = String(data.customerId ?? '').trim()
      const customerName = String(data.customerName ?? '').trim().slice(0, 200)
      if (!name) return NextResponse.json({ error: '发票号不能为空' }, { status: 400 })
      if (!customerId) return NextResponse.json({ error: '客户 ID 不能为空' }, { status: 400 })

      const rawLines = Array.isArray(data.lines) ? data.lines : []
      if (rawLines.length === 0) {
        return NextResponse.json({ error: '发票行不能为空' }, { status: 400 })
      }

      // 服务端重算每一行
      let subtotalExTax = 0
      let totalTax = 0
      const recomputedLines = rawLines.map((raw: InboundLine) => {
        const qty = Number(raw.qty ?? raw.quantity ?? 0)
        const unitPrice = Number(raw.unitPrice ?? 0)
        // taxRate 兼容两种存法：百分数(>1，如 23)归一为小数(0.23)；发票内部一律以小数计税
        const taxRateRaw = Number(raw.taxRate ?? 0)
        const taxRate = taxRateRaw > 1 ? taxRateRaw / 100 : taxRateRaw
        if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000) {
          throw Object.assign(new Error(`发票行数量无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        if (!Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000) {
          throw Object.assign(new Error(`发票行单价无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        if (!Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
          throw Object.assign(new Error(`发票行税率无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        const exTax = round2(qty * unitPrice)
        const taxAmt = round2(exTax * taxRate)
        const incTax = round2(exTax + taxAmt)
        subtotalExTax += exTax
        totalTax += taxAmt
        return {
          productId: String(raw.productId ?? ''),
          productName: String(raw.productName ?? '').trim().slice(0, 200),
          spec: String(raw.spec ?? '').trim().slice(0, 100),
          qty,
          unitPrice,
          taxRate,
          subtotalExTax: exTax,
          taxAmount: taxAmt,
          subtotalIncTax: incTax,
        }
      })
      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      const saleOrderIds: string[] = Array.isArray(data.saleOrderIds) ? data.saleOrderIds : []

      // 事务：发票创建 + 回写 OrderLine.invoicedQty = deliveredQty
      const invoice = await prisma.$transaction(async (tx) => {
        const created = await tx.invoice.create({
          data: {
            name,
            customerId,
            customerName,
            saleOrderIds,
            lines: recomputedLines as unknown as object,
            subtotalExTax,
            totalTax,
            totalIncTax,
            amountPaid: 0,
            amountDue: totalIncTax,
            status: String(data.status ?? 'DRAFT').toUpperCase() as 'DRAFT',
            paymentTerms: String(data.paymentTerms ?? 'monthly'),
            dueDate: data.dueDate ?? null,
          },
        })

        // 回写：开票数量 = 已交货数量
        if (saleOrderIds.length > 0) {
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          const txAny = tx as any
          await txAny.$executeRawUnsafe(
            `UPDATE "OrderLine" SET "invoicedQty" = "deliveredQty", "updatedAt" = NOW() WHERE "orderId" IN (${saleOrderIds.map((_, i) => `$${i + 1}`).join(',')})`,
            ...saleOrderIds,
          )
        }

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'invoice', resourceId: invoice.id,
        detail: `创建发票: ${invoice.name}, 金额 €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(invoice), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/invoices]', error)
      return NextResponse.json({ error: '创建发票失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
