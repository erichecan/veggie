import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { createDraftInvoiceForOrder } from '@/lib/invoice-from-order'

/**
 * POST /api/accounting/returns/bulk-invoice —— 会计核销页「补开漏开的发票」(20261026)
 * ⛔ 20261026：核销确认(RETURNED)时已经会自动触发开票（见 app/api/orders/bulk/route.ts
 * mark_returned），这个接口不再是主路径，只用来补救——核销当时开票失败、或历史遗留订单。
 * 对勾选的订单逐张调用同一套开票逻辑（lib/invoice-from-order.ts），单张失败不影响其它；
 * 幂等：已开过发票的订单直接跳过。权限与手工开票相同（finance.invoice.create）。
 *
 * ⛔ 20261026 code-review 修复：补开发票必须只针对已核销确认（returnStatus=RETURNED）的单。
 * 这个接口原来没有这层校验——如果在「待核销」tab 选中还没核对过送达量的单点这个按钮，
 * 会直接按下单量全送开票，整个绕开了"开票挪到核销确认之后，用核销时可能已修正的
 * deliveredQty"这个设计（本次改动的核心目的）。
 */
export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const ids = Array.isArray((body as { ids?: unknown }).ids) ? (body as { ids: string[] }).ids : []
      if (ids.length === 0) return NextResponse.json({ error: '未选择订单' }, { status: 400 })

      const orders = await prisma.order.findMany({ where: { id: { in: ids } }, select: { id: true, code: true, returnStatus: true } })
      const codeById = new Map(orders.map(o => [o.id, o.code ?? o.id.slice(-8)]))
      const returnStatusById = new Map(orders.map(o => [o.id, o.returnStatus]))

      const created: Array<{ code: string; invoiceId: string }> = []
      const skipped: Array<{ code: string; reason: string }> = []
      const failed: Array<{ code: string; error: string }> = []
      for (const id of ids) {
        const code = codeById.get(id) ?? id.slice(-8)
        if (returnStatusById.get(id) !== 'RETURNED') {
          skipped.push({ code, reason: '未核销确认（请先在待核销 tab 核对送达数量并确认核销）' })
          continue
        }
        try {
          const inv = await createDraftInvoiceForOrder(prisma as never, id)
          if (inv) created.push({ code, invoiceId: inv.id })
          else skipped.push({ code, reason: '已开过发票，或没有可开票的已交货数量' })
        } catch (e) {
          failed.push({ code, error: e instanceof Error ? e.message : String(e) })
        }
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
