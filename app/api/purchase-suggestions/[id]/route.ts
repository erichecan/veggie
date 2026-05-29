import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * P0-2: 采购建议单条操作
 *
 * GET    /api/purchase-suggestions/:id  — 查详情
 * PUT    /api/purchase-suggestions/:id  — 审批/拒绝/转采购单
 * DELETE /api/purchase-suggestions/:id  — 删除
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      const item = await prisma.purchaseSuggestion.findUnique({ where: { id } })
      if (!item) {
        return NextResponse.json({ error: '采购建议不存在' }, { status: 404 })
      }
      return NextResponse.json(serializeApi(item))
    } catch (error) {
      console.error('[GET /api/purchase-suggestions/[id]]', error)
      return NextResponse.json({ error: '获取采购建议详情失败' }, { status: 500 })
    }
  })
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const existing = await prisma.purchaseSuggestion.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '采购建议不存在' }, { status: 404 })
      }

      // 允许更新的字段
      const { status, suggestedQty, supplierId, supplierName, purchaseOrderId } = body

      // 验证 status 转换
      const validTransitions: Record<string, string[]> = {
        pending:  ['approved', 'rejected', 'ordered'],
        approved: ['ordered', 'rejected'],
        rejected: ['pending'],  // 可以重新激活
      }
      if (status && !validTransitions[existing.status]?.includes(status)) {
        return NextResponse.json(
          { error: `不能从 ${existing.status} 转换到 ${status}` },
          { status: 400 },
        )
      }

      const updateData: Record<string, unknown> = {}
      if (status) {
        updateData.status = status
        if (status === 'approved' || status === 'rejected' || status === 'ordered') {
          updateData.resolvedAt = new Date()
          updateData.resolvedBy = user.userId
        }
      }
      if (suggestedQty !== undefined) updateData.suggestedQty = suggestedQty
      if (supplierId !== undefined) updateData.supplierId = supplierId
      if (supplierName !== undefined) updateData.supplierName = supplierName
      if (purchaseOrderId !== undefined) updateData.purchaseOrderId = purchaseOrderId

      const updated = await prisma.purchaseSuggestion.update({
        where: { id },
        data: updateData,
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'purchase-suggestion', resourceId: id,
        detail: `更新采购建议: ${status ? `状态→${status}` : '修改数量/供应商'}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/purchase-suggestions/[id]]', error)
      return NextResponse.json({ error: '更新采购建议失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const existing = await prisma.purchaseSuggestion.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '采购建议不存在' }, { status: 404 })
      }

      await prisma.purchaseSuggestion.delete({ where: { id } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'purchase-suggestion', resourceId: id,
        detail: `删除采购建议: ${existing.productName}`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/purchase-suggestions/[id]]', error)
      return NextResponse.json({ error: '删除采购建议失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS'])
}
