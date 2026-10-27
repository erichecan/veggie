import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { getReturnOrderLines } from '@/lib/accounting/returns'

/**
 * GET /api/accounting/returns/[id]/lines —— 核销弹窗「核对数量」用的行明细（20261026）
 * 只读；权限与核销清单相同（finance.settlement.read），改数量走 POST /api/orders/bulk
 * （mark_returned + lines，权限 finance.write_off.confirm）。
 */
export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const lines = await getReturnOrderLines(id)
      return NextResponse.json({ lines })
    } catch (error) {
      console.error('[GET /api/accounting/returns/[id]/lines]', error)
      return NextResponse.json({ error: '获取订单行明细失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
