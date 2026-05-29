import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDispatchPrintData } from '@/lib/print/dispatch-loader'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date')
    const fromDate = searchParams.get('fromDate') ?? undefined
    const driverSlotId = searchParams.get('driverSlotId')

    if (!date || !driverSlotId) {
      return NextResponse.json(
        { error: '缺少参数 date 或 driverSlotId' },
        { status: 400 },
      )
    }

    try {
      const data = await loadDispatchPrintData(date, driverSlotId, fromDate)
      if (!data) {
        return NextResponse.json({ error: '该批次无订单数据' }, { status: 404 })
      }
      return NextResponse.json(data, {
        headers: { 'Cache-Control': 'no-store' },
      })
    } catch (error) {
      console.error('[GET /api/orders/dispatch-print-data]', error)
      return NextResponse.json(
        {
          error: '获取打印数据失败',
          message: error instanceof Error ? error.message : String(error),
        },
        { status: 500 },
      )
    }
  }, ALLOWED_ROLES)
}
