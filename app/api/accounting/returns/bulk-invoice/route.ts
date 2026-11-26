import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { createOrderInvoiceDraftsBatch, isUniqueViolation } from '@/lib/invoice-from-order'

import { lockReturnOrders } from '@/lib/return-invoice-guard'

/** Recover missing invoice drafts for reconciled orders without replaying one transaction per order. */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const ids = [...new Set<string>(Array.isArray(body.ids) ? body.ids.filter((id: unknown): id is string => typeof id === 'string' && Boolean(id.trim())) : [])]
      if (!ids.length || ids.length > 500) return NextResponse.json({ error: '请选择 1 至 500 张订单' }, { status: 400 })
      const run = () => prisma.$transaction(async tx => {
        await lockReturnOrders(tx, ids)
        const orders = await tx.order.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, returnStatus: true } })
        const result = await createOrderInvoiceDraftsBatch(tx, orders.filter(order => order.returnStatus === 'RETURNED').map(order => order.id))
        return { orders, ...result }
      }, { timeout: 60000, maxWait: 10000 })
      let result: Awaited<ReturnType<typeof run>>
      for (let attempt = 0; ; attempt++) {
        try { result = await run(); break }
        catch (error) { if (!isUniqueViolation(error) || attempt >= 2) throw error }
      }
      const byId = new Map(result.orders.map(order => [order.id, order]))
      const drafts = new Map(result.drafts.flatMap(draft => draft.saleOrderIds.map(id => [id, draft.id])))
      const held = new Set(result.deferred)
      const created: Array<{ code: string; invoiceId: string }> = []
      const skipped: Array<{ code: string; reason: string }> = []
      const failed: Array<{ code: string; error: string }> = []
      for (const id of ids) {
        const order = byId.get(id)
        const code = order?.code ?? id.slice(-8)
        const invoiceId = drafts.get(id)
        if (invoiceId) created.push({ code, invoiceId })
        else if (held.has(id)) failed.push({ code, error: '回单、退货或贷记尚待处理，暂不能开票' })
        else skipped.push({ code, reason: order?.returnStatus === 'RETURNED' ? '已开过发票，或没有可开票的已交货数量' : '订单尚未核销' })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'invoice', resourceId: 'bulk-from-write-off',
        detail: `会计核销页批量生成发票：共 ${ids.length} 张订单，开出 ${created.length} 张，跳过 ${skipped.length} 张，失败 ${failed.length} 张`
          + (created.length ? `（${created.map(c => c.code).slice(0, 50).join('、')}${created.length > 50 ? ' 等' : ''}）` : ''),
      })

      return NextResponse.json({ total: ids.length, created, skipped, failed })
    } catch (error) {
      console.error('[POST /api/accounting/returns/bulk-invoice]', error)
      return NextResponse.json({ error: '批量生成发票失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.create' })
}
