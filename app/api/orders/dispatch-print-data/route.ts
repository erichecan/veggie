import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { loadDispatchPrintData, parseDispatchSelector } from '@/lib/print/dispatch-loader'
import { ensureInvoiceNumbers } from '@/lib/invoice-number'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'DRIVER', 'FINANCE', 'SALES']

export async function GET(req: Request) {
  return withAuth(req, async () => {
    const { searchParams } = new URL(req.url)
    const date = searchParams.get('date')
    const fromDate = searchParams.get('fromDate') ?? undefined
    const selector = parseDispatchSelector(searchParams)

    // waveIds / driverSlotId / batchLabel 皆空 = 整日全部批次打印
    if (!date) {
      return NextResponse.json(
        { error: '缺少参数 date' },
        { status: 400 },
      )
    }

    try {
      const data = await loadDispatchPrintData(date, selector, fromDate)
      if (!data) {
        return NextResponse.json({ error: '该批次无订单数据' }, { status: 404 })
      }

      // 销售单要印 Invoice No.（客户拿这张纸去记账），所以取数时顺带把还没有号的
      // 订单发一个。只有 doc=sales 才发 —— 拣货单/送货单/汇总单不该消耗号段。
      // 发号是幂等的：已有号的订单原样返回，重复打印号不变。
      if (searchParams.get('doc') === 'sales') {
        const assigned = await ensureInvoiceNumbers(data.orders.map(o => o.id))
        for (const order of data.orders) {
          const no = assigned.get(order.id)
          if (no && !order.invoiceNo) order.invoiceNo = no
        }
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
  }, { require: 'sales.order.dispatch_print' })
}
