import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const p = prisma as any
    const logs = await p.orderAuditLog.findMany({
      where: { orderId: id },
      orderBy: { createdAt: 'desc' },
    })
    // Join user names in one query
    const userIds = [...new Set((logs as { userId: string }[]).map(l => l.userId).filter(Boolean))]
    const users = userIds.length
      ? await p.user.findMany({ where: { id: { in: userIds } }, select: { id: true, name: true } })
      : []
    const userMap = new Map((users as { id: string; name: string }[]).map((u) => [u.id, u.name]))
    const enriched = (logs as Record<string, unknown>[]).map(l => ({
      ...l,
      userName: userMap.get(l.userId as string) ?? null,
    }))
    return NextResponse.json(serializeApi(enriched))
  } catch (error) {
    console.error('[GET /api/orders/[id]/audit]', error)
    return NextResponse.json({ error: '获取审计日志失败' }, { status: 500 })
  }
}

/** POST — 用户主动写 note / message（chatter 用） */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const action = String(body.action ?? 'note').toLowerCase()
      const detail = String(body.detail ?? '').trim().slice(0, 1000)
      if (!detail) return NextResponse.json({ error: '内容不能为空' }, { status: 400 })
      if (!['note', 'message'].includes(action)) {
        return NextResponse.json({ error: 'action 必须是 note 或 message' }, { status: 400 })
      }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const log = await p.orderAuditLog.create({
        data: {
          orderId: id,
          userId: user.userId,
          action,
          changedFields: { detail },
        },
      })
      return NextResponse.json(serializeApi({ ...log, userName: user.name }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/orders/[id]/audit]', error)
      return NextResponse.json({ error: '写入失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'BOSS', 'SALES', 'EXTERNAL_SALES', 'FINANCE'])
}
