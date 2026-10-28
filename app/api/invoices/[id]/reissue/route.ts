import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { nextInvoiceName, type InvoiceTx } from '@/lib/invoice-from-order'

/**
 * POST /api/invoices/:id/reissue
 * ============================================================================
 * 历史订单换开新发票（20261028 M8）：原发票内容有误需要重开时，不直接改动旧票
 * （旧票可能已经给客户看过，改了对不上账），而是复制一份新 DRAFT 发票，旧票标记
 * SUPERSEDED。新票内容如需调整，走现有 PATCH /api/invoices/:id，这个接口只管「开新的」。
 *
 * 规则：
 *   - 旧票不能已经是 SUPERSEDED（不能重复换开）
 *   - 旧票不能已有 supersededBy（@unique 约束兜底，这里先查一次给出更友好的错误）
 *   - 旧票不能已有收款（amountPaid>0）或 credit note 核销（amountCredited>0）——否则新票
 *     amountDue 会按全额重算，旧票收款/核销记录随 SUPERSEDED 状态被 ar-summary 排除，
 *     造成已收款金额从应收账款里消失、同时凭空多出一笔全额应收（security-review 20261028
 *     识别为业务逻辑缺口，非安全漏洞，此处直接修复）
 *   - 事务：新建 DRAFT 发票（复制 lines/金额/客户/账期信息）+ 旧票状态改 SUPERSEDED
 */
export async function POST(req: Request, { params }: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await params
      const body = await req.json().catch(() => ({}))
      const reason = typeof body?.reason === 'string' ? body.reason.trim().slice(0, 500) : ''

      const old = await prisma.invoice.findUnique({
        where: { id },
        include: { supersededBy: { select: { id: true, name: true } } },
      })
      if (!old) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      if (old.status === 'SUPERSEDED') {
        return NextResponse.json({ error: '该发票已被换开过新票' }, { status: 409 })
      }
      if (old.supersededBy) {
        return NextResponse.json({ error: `该发票已换开为 ${old.supersededBy.name}` }, { status: 409 })
      }
      if (Number(old.amountPaid) > 0 || Number(old.amountCredited) > 0) {
        return NextResponse.json(
          { error: '该发票已有收款或credit note核销记录，换开会丢失这部分记录，请先在旧票上处理完收款/核销再换开' },
          { status: 409 },
        )
      }

      const result = await prisma.$transaction(async (tx) => {
        const name = await nextInvoiceName(tx as unknown as InvoiceTx)
        const created = await tx.invoice.create({
          data: {
            name,
            customerId: old.customerId,
            customerName: old.customerName,
            saleOrderIds: old.saleOrderIds,
            lines: old.lines as object,
            subtotalExTax: old.subtotalExTax,
            totalTax: old.totalTax,
            totalIncTax: old.totalIncTax,
            amountPaid: 0,
            amountCredited: 0,
            amountDue: old.totalIncTax,
            status: 'DRAFT',
            paymentTerms: old.paymentTerms,
            dueDate: old.dueDate,
            supersedesInvoiceId: old.id,
          },
        })
        const updatedOld = await tx.invoice.update({
          where: { id: old.id },
          data: { status: 'SUPERSEDED' },
        })
        return { created, updatedOld }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'invoice', resourceId: result.created.id,
        detail: `发票 ${old.name} 换开新票 ${result.created.name}${reason ? ` — ${reason}` : ''}`,
        changes: { status: { before: old.status, after: 'SUPERSEDED' } },
      })

      return NextResponse.json(serializeApi({
        oldInvoice: result.updatedOld,
        newInvoice: result.created,
      }), { status: 201 })
    } catch (error) {
      console.error('[POST /api/invoices/:id/reissue]', error)
      return NextResponse.json({ error: '换开新发票失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.create' })
}
