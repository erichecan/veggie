import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createPurchaseOrder } from '@/lib/create-purchase-order'
import { isValidPurchaseTaxRate } from '@/lib/purchase/tax-rates'

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
      // 税率是百分数(0 / 13.5 / 23)，与采购单行同一单位；不传 = 按商品/供应商的 Vendor Tax 带出
      // ⛔ 20261013 修：以前前端把供应商档案的小数 0.23 直接传进来、这里再按小数算税额，
      // 采购单行存下 taxRate=0.23，采购单页面当百分数显示成 0.2%，金额也对不上
      const taxRate = body.taxRate === undefined || body.taxRate === null || body.taxRate === '' ? undefined : Number(body.taxRate)
      if (taxRate !== undefined && !isValidPurchaseTaxRate(taxRate)) {
        return NextResponse.json({ error: '税率只能是 0 / 13.5 / 23（%）' }, { status: 400 })
      }
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
      // 准入闸门(同 lib/create-purchase-order.ts)：商品取消了 Can be Purchased 就不能再转采购单
      const product = await p.product.findUnique({ where: { id: suggestion.productId }, select: { name: true, canBePurchased: true } })
      if (product && product.canBePurchased === false) {
        return NextResponse.json({ error: `商品「${product.name}」已设为不可采购（Can be Purchased 未勾选），不能转采购单` }, { status: 400 })
      }

      const po = await p.$transaction(async (tx: typeof p) => {
        // 与新建采购单同一套 SSOT：编号、金额、默认税率、可采购闸门都在 createPurchaseOrder 里
        const created = await createPurchaseOrder(tx, {
          supplierId,
          createdBy: user.userId,
          notes: body.notes ?? null,
          lines: [{
            productId: suggestion.productId,
            productName: suggestion.productName ?? '',
            orderedQty: qty,
            unitCost,
            taxRate,
            sequence: 10,
          }],
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
        detail: `采购建议转采购单 ${po.name}，商品 ${suggestion.productName}，数量 ${qty}，金额 €${Number(po.totalIncTax)}`,
      })

      return NextResponse.json(serializeApi(po), { status: 201 })
    } catch (error) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) return NextResponse.json({ error: err.message }, { status: err.status })
      console.error('[POST /api/purchase-suggestions/[id]/convert]', error)
      return NextResponse.json({ error: '转采购单失败' }, { status: 500 })
    }
  }, { require: 'purchase.suggestion.manage' })
}
