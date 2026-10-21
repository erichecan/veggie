import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { listDriverCash, CASH_ORDER_STATUSES } from '@/lib/accounting/driver-cash'

/**
 * 会计核销页「钱」板块的取数入口——按「司机 × 送货日」汇总应收（现金/转账），附带有没有被会计确认过。
 * 金额来自实际送出去的订单，不依赖司机自己申报（见 DEV-PLAN 20260924）。
 * 20261021 起跨天：没确认的那几天一直列着，刚确认的留 24 小时（lib/accounting/driver-cash.ts）。
 *   ?from=&to=  按送货日期收窄（可选）
 * businessDate 仍返回「今天」，供「单」板块用。
 */
/** 计入司机应收的订单状态：货已离仓（20261021 起与「单」板块同口径，原来还含已确认/已排波次） */
export const ACTIVE_STATUSES = CASH_ORDER_STATUSES

export async function GET(req: Request) {
  return withAuth(req, async () => {
    try {
      const sp = new URL(req.url).searchParams
      const day = (v: string | null) => (v && /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : null)
      return NextResponse.json(await listDriverCash({ from: day(sp.get('from')), to: day(sp.get('to')) }))
    } catch (error) {
      console.error('[GET /api/accounting/driver-cash]', error)
      return NextResponse.json({ error: '获取司机收款汇总失败' }, { status: 500 })
    }
  }, { require: 'finance.settlement.read' })
}
