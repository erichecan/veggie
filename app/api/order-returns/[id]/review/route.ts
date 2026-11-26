import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { writeLog } from '@/lib/action-log'
import { reviewOrderReturn } from '@/lib/return-workflow'

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async user => {
    try {
      const { id } = await params
      const body = await req.json()
      if (!['approve', 'reject'].includes(body.action)) return NextResponse.json({ error: '请选择批准或拒绝' }, { status: 400 })
      const result = await prisma.$transaction(tx => reviewOrderReturn(tx, id, body, user))
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name, action: 'UPDATE', resource: 'order_return', resourceId: id, detail: body.action === 'approve' ? '销售完成退货审核并提交会计，报废已按适用规则处理' : `销售拒绝退货：${body.note}` })
      return NextResponse.json(serializeApi(result))
    } catch (error) {
      return NextResponse.json({ error: error instanceof Error ? error.message : '审核失败' }, { status: Number((error as { status?: number }).status) || 500 })
    }
  }, { require: 'dispatch.goods_return.review' })
}
