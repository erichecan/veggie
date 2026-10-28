import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'

/**
 * 仓库核实（退货/报废整合 M3，对齐 app/api/trips/[id]/returns/warehouse-verify 的既有规则）：
 * 日销售中心登记的退货先落 WAREHOUSE_PENDING，仓库去核对实物是否真的收到、与登记单是否一致，
 * 核实通过才转 PENDING_REVIEW 进入 operator/inventory「退换货」看板的审核栏；核实不通过直接
 * 打回（REJECTED），不做多级申诉。
 *
 * PUT /api/order-returns/:id/warehouse-verify
 * body: { action: 'verify' | 'reject', note?: string }
 */
export async function PUT(
  req: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json()
      const { action, note } = body as { action?: 'verify' | 'reject'; note?: string }

      if (action !== 'verify' && action !== 'reject') {
        return NextResponse.json({ error: '缺少必填字段: action(verify|reject)' }, { status: 400 })
      }
      if (action === 'reject' && !note?.trim()) {
        return NextResponse.json({ error: '核实不通过必须填写原因' }, { status: 400 })
      }

      const ret = await prisma.orderReturn.findUnique({ where: { id } })
      if (!ret) {
        return NextResponse.json({ error: '退货记录不存在' }, { status: 404 })
      }
      if (ret.status !== 'WAREHOUSE_PENDING') {
        return NextResponse.json(
          { error: `当前状态 ${ret.status} 不是待仓库核实，可能已被处理或数据已过期`, status: ret.status },
          { status: 409 },
        )
      }

      const updated = await prisma.orderReturn.update({
        where: { id },
        data: {
          status: action === 'verify' ? 'PENDING_REVIEW' : 'REJECTED',
          warehouseVerifiedById: user.userId,
          warehouseVerifiedByName: user.name,
          warehouseVerifiedAt: new Date(),
          warehouseNote: note?.trim() || undefined,
        },
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'order_return', resourceId: id,
        detail: `仓库核实退货: ${ret.productName} × ${ret.quantity} — ${action === 'verify' ? '核实通过' : `核实不通过(${note})`}`,
      })

      return NextResponse.json(serializeApi({
        message: action === 'verify' ? '已核实通过，转入审核' : '已标记核实不通过，退货申请已打回',
        orderReturn: updated,
      }))
    } catch (error) {
      console.error('[PUT /api/order-returns/[id]/warehouse-verify]', error)
      return NextResponse.json({ error: '仓库核实失败' }, { status: 500 })
    }
  }, { require: 'dispatch.goods_return.warehouse_verify' })
}
