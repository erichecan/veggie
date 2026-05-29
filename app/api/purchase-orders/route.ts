import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * /api/purchase-orders
 * ============================================================================
 * 采购订单（Odoo purchase.order）
 *
 * GET  → 列表（支持 supplierId / status / 分页）
 * POST → 新建 RFQ / DRAFT 订单。金额由服务端重算。
 *
 * 工作流：
 *   DRAFT(RFQ) → SENT → CONFIRMED → RECEIVED（通过 GoodsReceipt）→ INVOICED（通过 VendorBill）
 *   任何阶段都可以 CANCELLED（除 RECEIVED 后不建议再撤）
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

interface InboundLine {
  productId: string
  productName?: string
  uomId?: string | null
  orderedQty: number
  unitCost: number
  taxRate?: number
  sequence?: number
  bestBefore?: string | null
}

export async function GET(req: Request) {
  try {
    const { searchParams } = new URL(req.url)
    const supplierId = searchParams.get('supplierId')
    const status = searchParams.get('status')?.toUpperCase()
    const limit = Math.min(500, Math.max(1, parseInt(searchParams.get('limit') ?? '200', 10)))

    const where: Record<string, unknown> = {}
    if (supplierId) where.supplierId = supplierId
    if (status) where.status = status

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const rows = await p.purchaseOrder.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: { lines: true },
    })

    // 补全 supplierName —— PurchaseOrder 只存 supplierId，需要从 Customer 表查名字
    const supplierIds = [...new Set(rows.map((r: { supplierId: string }) => r.supplierId).filter(Boolean))]
    const suppliers = supplierIds.length > 0
      ? await p.customer.findMany({
          where: { id: { in: supplierIds } },
          select: { id: true, name: true },
        })
      : []
    const supplierMap = new Map(suppliers.map((s: { id: string; name: string }) => [s.id, s.name]))

    const enriched = rows.map((r: Record<string, unknown>) => ({
      ...r,
      supplierName: supplierMap.get(r.supplierId as string) ?? r.supplierId,
    }))

    return NextResponse.json(serializeApi(enriched))
  } catch (error) {
    console.error('[GET /api/purchase-orders]', error)
    return NextResponse.json({ error: '获取采购订单失败' }, { status: 500 })
  }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const supplierId = String(data.supplierId ?? '').trim()
      if (!supplierId) return NextResponse.json({ error: '供应商不能为空' }, { status: 400 })

      const rawLines: InboundLine[] = Array.isArray(data.lines) ? data.lines : []
      if (rawLines.length === 0) {
        return NextResponse.json({ error: '采购行不能为空' }, { status: 400 })
      }

      // 服务端重算每一行金额
      let subtotalExTax = 0
      let totalTax = 0
      const recomputedLines = rawLines.map((raw) => {
        const qty = Number(raw.orderedQty)
        const unitCost = Number(raw.unitCost)
        const taxRate = Number(raw.taxRate ?? 0)
        if (!Number.isFinite(qty) || qty <= 0) {
          throw Object.assign(new Error(`采购行数量无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        if (!Number.isFinite(unitCost) || unitCost < 0 || unitCost > 1_000_000) {
          throw Object.assign(new Error(`采购行单价无效：${raw.productName ?? raw.productId}`), { status: 400 })
        }
        const ex = round2(qty * unitCost)
        const tax = round2(ex * taxRate)
        const inc = round2(ex + tax)
        subtotalExTax += ex
        totalTax += tax
        return {
          productId: raw.productId,
          productName: String(raw.productName ?? '').trim().slice(0, 200),
          uomId: raw.uomId ?? null,
          orderedQty: qty,
          receivedQty: 0,
          invoicedQty: 0,
          unitCost,
          taxRate,
          subtotalExTax: ex,
          taxAmount: tax,
          subtotalIncTax: inc,
          bestBefore: raw.bestBefore ? new Date(raw.bestBefore) : null,
          sequence: raw.sequence ?? 10,
        }
      })
      subtotalExTax = round2(subtotalExTax)
      totalTax = round2(totalTax)
      const totalIncTax = round2(subtotalExTax + totalTax)

      // 生成 PO 编号
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const count = await p.purchaseOrder.count()
      const name = `PO-${String(count + 1).padStart(5, '0')}`

      const po = await p.$transaction(async (tx: typeof p) => {
        const created = await tx.purchaseOrder.create({
          data: {
            name,
            supplierId,
            status: 'DRAFT',
            orderDate: data.orderDate ? new Date(data.orderDate) : new Date(),
            expectedDate: data.expectedDate ? new Date(data.expectedDate) : null,
            currency: data.currency ?? 'EUR',
            subtotalExTax,
            totalTax,
            totalIncTax,
            notes: data.notes ?? null,
            createdBy: user.userId,
            lines: { create: recomputedLines },
          },
          include: { lines: true },
        })
        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase_order', resourceId: po.id,
        detail: `创建采购订单 ${name}, 金额 €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(po), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/purchase-orders]', error)
      return NextResponse.json({ error: '创建采购订单失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
