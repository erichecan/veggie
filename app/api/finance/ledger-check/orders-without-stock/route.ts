import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { fixOrdersWithoutStock } from '@/lib/ledger-check'

/**
 * POST /api/finance/ledger-check/orders-without-stock —— 统一补扣（客户 20261015 确认）
 * 对「已确认但从未占用库存」的订单按订单行补占库存，逻辑与确认订单相同（lib/order-stock.ts）。
 * 会改库存，权限要求与手工调整库存相同（stock.move.create）。可重复调用，已补过的单不会再扣。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const r = await fixOrdersWithoutStock({ userId: user.userId, name: user.name ?? user.email })
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'stock-move', resourceId: 'orders-without-stock',
        detail: `统一补扣已确认未占用库存的订单：共 ${r.total} 张，成功 ${r.fixed.length} 张，失败 ${r.failed.length} 张`
          + (r.fixed.length ? `（${r.fixed.map(f => f.code).slice(0, 50).join('、')}${r.fixed.length > 50 ? ' 等' : ''}）` : ''),
      })
      return NextResponse.json(r)
    } catch (error) {
      console.error('[POST /api/finance/ledger-check/orders-without-stock]', error)
      return NextResponse.json({ error: '统一补扣失败' }, { status: 500 })
    }
  }, { require: 'stock.move.create' })
}
