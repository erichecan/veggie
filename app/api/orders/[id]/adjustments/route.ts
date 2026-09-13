import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { assertOrderNotPickLockedForLineEdit, WavePickLockedError } from '@/lib/wave-pick-lock'
import { listAdjustments, createAdjustment } from '@/lib/order-adjustments'
import { serializeApi } from '@/lib/api-serializer'
import type { $Enums } from '@/lib/generated/prisma/client'

const ADJUSTMENT_TYPES: readonly $Enums.OrderAdjustmentType[] = ['DISCOUNT', 'DELIVERY_FEE', 'PRICE_CORRECTION', 'OTHER']
const LOCKED_STATUSES = ['LOCKED', 'CANCELLED', 'COMPLETED']

/**
 * GET /api/orders/:id/adjustments —— 列出该订单的调整行（折扣/配送费/差价修正）。
 * POST /api/orders/:id/adjustments —— 新增一条调整行。
 * 见 lib/order-adjustments.ts 顶部注释。
 */
export async function GET(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async () => {
    const { id } = await params
    const order = await prisma.order.findUnique({ where: { id }, select: { id: true } })
    if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
    const adjustments = await listAdjustments(id)
    return NextResponse.json(serializeApi(adjustments))
  }, { require: 'sales.order.manage_adjustment' })
}

export async function POST(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const order = await prisma.order.findUnique({
        where: { id },
        select: { id: true, status: true },
      })
      if (!order) return NextResponse.json({ error: '订单不存在' }, { status: 404 })
      if (LOCKED_STATUSES.includes(order.status)) {
        return NextResponse.json({ error: '该订单状态不允许修改明细' }, { status: 403 })
      }
      // 新增调整行等价于加内容，拣货锁定期间不放行（与加行同一把闸）
      await assertOrderNotPickLockedForLineEdit(id, false)

      const body = await req.json()
      const type = String(body.type ?? '')
      if (!ADJUSTMENT_TYPES.includes(type as $Enums.OrderAdjustmentType)) {
        return NextResponse.json({ error: '无效的调整类型' }, { status: 400 })
      }

      const adjustment = await createAdjustment({
        orderId: id,
        type: type as $Enums.OrderAdjustmentType,
        label: String(body.label ?? ''),
        amount: Number(body.amount),
        note: body.note != null ? String(body.note) : null,
        createdById: user.userId,
      })

      await writeLog({
        userId: user.userId,
        userEmail: user.email,
        userName: user.name,
        action: 'CREATE',
        resource: 'order',
        resourceId: id,
        detail: `新增调整行: ${adjustment.label}（${adjustment.type}，金额 €${adjustment.amount}）`,
      })

      return NextResponse.json(serializeApi(adjustment), { status: 201 })
    } catch (e) {
      if (e instanceof WavePickLockedError) {
        return NextResponse.json({ error: e.message }, { status: 409 })
      }
      const err = e as { status?: number; message?: string }
      if (err.status && err.status >= 400 && err.status < 500) {
        return NextResponse.json({ error: err.message ?? '请求无效' }, { status: err.status })
      }
      console.error('[POST order adjustment]', e)
      return NextResponse.json(
        { error: e instanceof Error ? e.message : '添加失败' },
        { status: 500 },
      )
    }
  }, { require: 'sales.order.manage_adjustment' })
}
