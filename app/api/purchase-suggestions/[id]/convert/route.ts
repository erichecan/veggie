import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * POST /api/purchase-suggestions/:id/convert
 *
 * 将采购建议直接转为采购订单（PurchaseOrder）。
 * 前端在"采纳"弹窗中确认数量 / 供应商 / 单价后调用此接口。
 *
 * Body:
 *   qty         — 采购数量（默认取 suggestion.suggestedQty）
 *   supplierId  — 供应商 ID
 *   supplierName— 供应商名称（冗余，方便前端显示）
 *   unitCost    — 单价
 *   taxRate     — 税率（默认 0）
 *   notes       — 备注
 *
 * 事务内完成：
 *   1. 生成 PO 编号
 *   2. 创建 PurchaseOrder + 1 行 PurchaseOrderLine
 *   3. 将 PurchaseSuggestion 状态改为 ordered，关联 purchaseOrderId
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any

      const suggestion = await p.purchaseSuggestion.findUnique({ where: { id } })
      if (!suggestion) {
        return NextResponse.json({ error: '采购建议不存在' }, { status: 404 })
      }
      if (suggestion.status !== 'pending' && suggestion.status !== 'approved') {
        return NextResponse.json(
          { error: `当前状态 ${suggestion.status} 不允许转采购单` },
          { status: 400 },
        )
      }

      const qty = Number(body.qty ?? suggestion.suggestedQty)
      const unitCost = Number(body.unitCost ?? 0)
      const taxRate = Number(body.taxRate ?? 0)
      const supplierId = String(body.supplierId ?? suggestion.supplierId ?? '').trim()

      if (!Number.isFinite(qty) || qty <= 0) {
        return NextResponse.json({ error: '采购数量无效' }, { status: 400 })
      }
      if (!Number.isFinite(unitCost) || unitCost < 0) {
        return NextResponse.json({ error: '单价无效' }, { status: 400 })
      }
      if (!supplierId) {
        return NextResponse.json({ error: '请选择供应商' }, { status: 400 })
      }

      // 计算金额
      const subtotalExTax = round2(qty * unitCost)
      const totalTax = round2(subtotalExTax * taxRate)
      const totalIncTax = round2(subtotalExTax + totalTax)

      const po = await p.$transaction(async (tx: typeof p) => {
        // 生成 PO 编号
        const count = await tx.purchaseOrder.count()
        const name = `PO-${String(count + 1).padStart(5, '0')}`

        // 创建采购订单
        const created = await tx.purchaseOrder.create({
          data: {
            name,
            supplierId,
            status: 'DRAFT',
            orderDate: new Date(),
            currency: 'EUR',
            subtotalExTax,
            totalTax,
            totalIncTax,
            notes: body.notes ?? null,
            createdBy: user.userId,
            lines: {
              create: [{
                productId: suggestion.productId,
                productName: suggestion.productName ?? '',
                orderedQty: qty,
                receivedQty: 0,
                invoicedQty: 0,
                unitCost,
                taxRate,
                subtotalExTax,
                taxAmount: totalTax,
                subtotalIncTax: totalIncTax,
                sequence: 10,
              }],
            },
          },
          include: { lines: true },
        })

        // 更新建议状态
        await tx.purchaseSuggestion.update({
          where: { id },
          data: {
            status: 'ordered',
            purchaseOrderId: created.id,
            // 采纳时把建议量改写成实际下单量，让这一行读起来就是「最后订了多少」。
            // ⚠️ estimatedCost 必须跟着一起改：只改数量不改金额，列表上会出现
            // 「建议采购 12 · 预估成本 €100」这种自相矛盾的行（€100 是按原建议 20 算的）。
            suggestedQty: qty,
            estimatedCost: round2(qty * unitCost),
            supplierId,
            supplierName: body.supplierName ?? suggestion.supplierName,
            resolvedAt: new Date(),
            resolvedBy: user.userId,
          },
        })

        return created
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase_order', resourceId: po.id,
        detail: `采购建议转采购单 ${po.name}，商品 ${suggestion.productName}，数量 ${qty}，金额 €${totalIncTax}`,
      })

      return NextResponse.json(serializeApi(po), { status: 201 })
    } catch (error) {
      console.error('[POST /api/purchase-suggestions/[id]/convert]', error)
      return NextResponse.json({ error: '转采购单失败' }, { status: 500 })
    }
  }, { require: 'purchase.suggestion.manage' })
}
