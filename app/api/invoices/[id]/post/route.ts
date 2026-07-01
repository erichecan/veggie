import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { postInvoiceToJournal } from '@/lib/accounting'
import { serializeApi } from '@/lib/api-serializer'
import { writebackInvoicedQty } from '@/lib/invoice-invoiced-qty'

/**
 * POST /api/invoices/:id/post
 * ============================================================================
 * 发票 DRAFT → POSTED。同步自动生成会计凭证（JournalEntry）。
 *
 * 规则：
 *   - 当前必须是 DRAFT
 *   - 事务：更新 invoice.status + 生成凭证 + 回写 invoice.postedAt
 *   - 若标准科目未预置（未跑 seed），凭证跳过但发票仍 POSTED（给提示）
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const inv = await p.invoice.findUnique({ where: { id } })
      if (!inv) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      if (inv.status !== 'DRAFT') {
        return NextResponse.json({ error: `当前状态 ${inv.status} 不能 POST（仅 DRAFT 可以）` }, { status: 409 })
      }

      const result = await p.$transaction(async (tx: typeof p) => {
        const entry = await postInvoiceToJournal(tx, inv, user.userId)
        const updated = await tx.invoice.update({
          where: { id },
          data: { status: 'POSTED', postedAt: new Date().toISOString() },
        })
        // 回写 OrderLine.invoicedQty=deliveredQty(B-2: 优先按发票行 orderLineId 精确到行,回退整单)
        await writebackInvoicedQty(tx, inv.lines, Array.isArray(inv.saleOrderIds) ? inv.saleOrderIds : [])
        return { invoice: updated, entry }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'invoice', resourceId: id,
        detail: `发票 ${inv.name} POST${result.entry ? `，凭证 ${result.entry.name}` : '（未找到标准科目，跳过凭证）'}`,
        changes: { status: { before: 'DRAFT', after: 'POSTED' } },
      })

      return NextResponse.json(serializeApi({
        ...result.invoice,
        journalEntry: result.entry,
        warning: result.entry ? undefined : '标准会计科目未配置，凭证未生成。请先跑 npm run db:seed 或手动配置 Account 表。',
      }))
    } catch (error) {
      console.error('[POST /api/invoices/:id/post]', error)
      return NextResponse.json({ error: '发票过账失败' }, { status: 500 })
    }
  }, ['OPERATOR', 'FINANCE', 'BOSS'])
}
