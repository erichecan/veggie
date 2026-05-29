import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog } from '@/lib/action-log'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const purchase = await prisma.purchaseRecord.findUnique({ where: { id } })
    if (!purchase) return NextResponse.json({ error: '采购记录不存在' }, { status: 404 })
    return NextResponse.json(serializeApi(purchase))
  } catch (error) {
    console.error('[GET /api/purchases/[id]]', error)
    return NextResponse.json({ error: '获取采购记录失败' }, { status: 500 })
  }
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      await prisma.purchaseRecord.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'purchase', resourceId: id,
        detail: `删除采购记录: ${id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/purchases/[id]]', error)
      return NextResponse.json({ error: '删除采购记录失败' }, { status: 500 })
    }
  })
}
