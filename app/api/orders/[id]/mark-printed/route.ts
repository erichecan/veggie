import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

const VALID_PRINT_TYPES = new Set(['DELIVERY', 'SALES'])
const PRINT_TYPE_LABEL: Record<string, string> = { DELIVERY: '送货单', SALES: '销售单' }

// POST /api/orders/[id]/mark-printed — 记录销售单打印状态（时间/打印人/类型/次数）
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = (await req.json().catch(() => ({}))) as { type?: string }
      const type = String(body.type ?? '').toUpperCase()
      if (!VALID_PRINT_TYPES.has(type)) {
        return NextResponse.json({ error: '无效的打印类型，需为 DELIVERY 或 SALES' }, { status: 400 })
      }

      const existing = await prisma.order.findUnique({
        where: { id },
        select: { id: true, code: true, printCount: true },
      })
      if (!existing) return NextResponse.json({ error: '订单不存在' }, { status: 404 })

      const order = await prisma.order.update({
        where: { id },
        data: {
          printedAt: new Date(),
          printedById: user.userId,
          printedByName: user.name ?? null,
          printType: type,
          printCount: { increment: 1 },
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order', resourceId: id,
        detail: `打印${PRINT_TYPE_LABEL[type]}: ${existing.code ?? id}（第 ${existing.printCount + 1} 次）`,
      })

      return NextResponse.json(serializeApi(order))
    } catch (error) {
      console.error('[POST /api/orders/[id]/mark-printed]', error)
      return NextResponse.json({ error: '记录打印状态失败' }, { status: 500 })
    }
  }, { require: 'sales.order.mark_printed' })
}
