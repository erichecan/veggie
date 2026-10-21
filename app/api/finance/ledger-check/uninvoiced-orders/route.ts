import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { fixUninvoicedOrders } from '@/lib/ledger-check'

/**
 * POST /api/finance/ledger-check/uninvoiced-orders —— 统一补开草稿发票（客户 20261021「待开票」）
 * 对「已完成但没有发票」的订单：实送量没记过的按全送补上，再按完成时同一套逻辑开草稿发票。
 * 会建发票，权限与手工开票相同（finance.invoice.create）。可重复调用，已开过的单不会再开。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const r = await fixUninvoicedOrders()
      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'invoice', resourceId: 'uninvoiced-orders',
        detail: `统一补开草稿发票：共 ${r.total} 张已完成未开票订单，开出 ${r.fixed.length} 张，跳过 ${r.skipped.length} 张，失败 ${r.failed.length} 张`
          + (r.fixed.length ? `（${r.fixed.map(f => f.code).slice(0, 50).join('、')}${r.fixed.length > 50 ? ' 等' : ''}）` : ''),
      })
      return NextResponse.json(r)
    } catch (error) {
      console.error('[POST /api/finance/ledger-check/uninvoiced-orders]', error)
      return NextResponse.json({ error: '统一补开发票失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.create' })
}
