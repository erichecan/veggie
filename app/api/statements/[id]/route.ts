import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * P1-1: 对账单单条操作
 *
 * GET    /api/statements/:id  — 查详情
 * PUT    /api/statements/:id  — 更新状态（draft→confirmed→sent）
 * DELETE /api/statements/:id  — 删除（仅 draft 可删）
 */

export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    try {
      const { id } = await params
      const item = await prisma.statement.findUnique({ where: { id } })
      if (!item) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }
      return NextResponse.json(serializeApi(item))
    } catch (error) {
      console.error('[GET /api/statements/[id]]', error)
      return NextResponse.json({ error: '获取对账单详情失败' }, { status: 500 })
    }
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}

export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()

      const existing = await prisma.statement.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }

      const { status } = body

      // 状态转换验证
      const validTransitions: Record<string, string[]> = {
        draft:     ['confirmed'],
        confirmed: ['sent', 'draft'],   // confirmed 可退回 draft 重新编辑
        sent:      [],                   // sent 后不可变更
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
        if (status === 'sent') {
          updateData.sentAt = new Date()
        }
      }

      const updated = await prisma.statement.update({
        where: { id },
        data: updateData,
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'statement', resourceId: id,
        detail: `更新对账单: 状态→${status}`,
      })

      return NextResponse.json(serializeApi(updated))
    } catch (error) {
      console.error('[PUT /api/statements/[id]]', error)
      return NextResponse.json({ error: '更新对账单失败' }, { status: 500 })
    }
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}

export async function DELETE(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const existing = await prisma.statement.findUnique({ where: { id } })
      if (!existing) {
        return NextResponse.json({ error: '对账单不存在' }, { status: 404 })
      }

      if (existing.status !== 'draft') {
        return NextResponse.json(
          { error: '只能删除 draft 状态的对账单' },
          { status: 400 },
        )
      }

      await prisma.statement.delete({ where: { id } })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'statement', resourceId: id,
        detail: `删除对账单: ${existing.customerName} ${existing.periodStart.toISOString().slice(0, 10)}~${existing.periodEnd.toISOString().slice(0, 10)}`,
      })

      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/statements/[id]]', error)
      return NextResponse.json({ error: '删除对账单失败' }, { status: 500 })
    }
  }, ['FINANCE', 'OPERATOR', 'BOSS'])
}
