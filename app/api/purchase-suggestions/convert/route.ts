import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { createPurchaseOrder } from '@/lib/create-purchase-order'
import { notifyRole } from '@/lib/notify'

/**
 * POST /api/purchase-suggestions/convert
 * body: { suggestionIds: string[], advanceToApproval?: boolean }
 *
 * 把勾选的采购建议按 supplierId 分组，每个供应商生成一张 DRAFT 采购单，
 * 建议行状态置为 ordered 并回填 purchaseOrderId（避免同一条建议被重复转单）。
 * 没有匹配供应商（supplierId 为空）的建议会被跳过，返回里单独列出供前端提示。
 *
 * advanceToApproval=true（干货年度计划用）：创建后直接推进到 TO_APPROVE 并通知 BOSS，
 * 不停在 DRAFT 等人手动一步步点"发送/确认"——年度计划金额大，本来就是要先审批。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const { suggestionIds, advanceToApproval } = await req.json()
      const ids: string[] = Array.isArray(suggestionIds) ? suggestionIds.filter(Boolean) : []
      if (ids.length === 0) return NextResponse.json({ error: '未选择任何建议' }, { status: 400 })

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const suggestions = await p.purchaseSuggestion.findMany({
        where: { id: { in: ids }, status: 'pending' },
      })
      if (suggestions.length === 0) {
        return NextResponse.json({ error: '选中的建议已被处理，请刷新后重试' }, { status: 409 })
      }

      const withSupplier = suggestions.filter((s: { supplierId: string | null }) => s.supplierId)
      const skipped = suggestions.filter((s: { supplierId: string | null }) => !s.supplierId)

      const bySupplier = new Map<string, typeof suggestions>()
      for (const s of withSupplier) {
        const arr = bySupplier.get(s.supplierId) ?? []
        arr.push(s)
        bySupplier.set(s.supplierId, arr)
      }

      const createdPOs: Array<{ id: string; name: string; supplierId: string }> = []

      await p.$transaction(async (tx: typeof p) => {
        for (const [supplierId, rows] of bySupplier.entries()) {
          const po = await createPurchaseOrder(tx, {
            supplierId,
            createdBy: user.userId,
            lines: rows.map((s: { productId: string; productName: string; suggestedQty: unknown; estimatedCost: unknown }, i: number) => {
              const qty = Number(s.suggestedQty)
              const unitCost = qty > 0 ? Number(s.estimatedCost ?? 0) / qty : 0
              return {
                productId: s.productId,
                productName: s.productName,
                orderedQty: qty,
                unitCost,
                sequence: (i + 1) * 10,
              }
            }),
          })
          if (advanceToApproval) {
            await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'SENT' } })
            await tx.purchaseOrder.update({ where: { id: po.id }, data: { status: 'TO_APPROVE', editApprovalRequired: true } })
          }
          createdPOs.push({ id: po.id, name: po.name, supplierId })
          await tx.purchaseSuggestion.updateMany({
            where: { id: { in: rows.map((s: { id: string }) => s.id) } },
            data: { status: 'ordered', purchaseOrderId: po.id, resolvedAt: new Date(), resolvedBy: user.userId },
          })
        }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'purchase_order',
        detail: `采购建议转采购单：生成 ${createdPOs.length} 张（${createdPOs.map(p2 => p2.name).join(', ')}）${advanceToApproval ? '，已提交审批' : ''}`,
      })

      if (advanceToApproval && createdPOs.length > 0) {
        await notifyRole(['BOSS'], {
          type: 'po_to_approve',
          title: `${createdPOs.length} 张采购单待审批`,
          body: `${createdPOs.map(po2 => po2.name).join(', ')} 已提交审批，请及时处理。`,
          data: { purchaseOrderIds: createdPOs.map(po2 => po2.id) },
        })
      }

      return NextResponse.json(serializeApi({
        createdPOs,
        skippedCount: skipped.length,
      }), { status: 201 })
    } catch (error: unknown) {
      const err = error as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? 'Bad Request' }, { status: err.status })
      }
      console.error('[POST /api/purchase-suggestions/convert]', error)
      return NextResponse.json({ error: '转采购单失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'WAREHOUSE'])
}
