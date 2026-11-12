import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { writeLog, diffChanges } from '@/lib/action-log'
import { recomputeInvoiceBalance } from '@/lib/finance/invoice-balance'
import { withAuth } from '@/lib/auth'
import { serializeApi } from '@/lib/api-serializer'
import { fetchProductSequences } from '@/lib/print/product-sequence'
import { fetchUomSequences, resolveUomSequence } from '@/lib/print/uom-sequence'

const INVOICE_TRACKED_FIELDS = [
  'name', 'status', 'customerName', 'subtotalExTax', 'totalTax', 'totalIncTax',
  'amountDue', 'paymentTerms', 'dueDate', 'postedAt',
]

export async function GET(_req: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params
    const found = await prisma.invoice.findUnique({
      where: { id },
      // 贷记单抵扣明细（20261014 L1）：发票页「收款记录」里和收款一起列出来
      include: { creditAllocations: { orderBy: { createdAt: 'asc' }, include: { creditNote: { select: { id: true, name: true } } } } },
    })
    if (!found) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
    const invoice = found
    const relatedOrders = invoice.saleOrderIds.length > 0
      ? await prisma.order.findMany({ where: { id: { in: invoice.saleOrderIds } }, select: { id: true, code: true } })
      : []
    const codeById = new Map(relatedOrders.map(order => [order.id, order.code ?? order.id.slice(-6).toUpperCase()]))
    const saleOrderCodes = invoice.saleOrderIds.map(orderId => codeById.get(orderId)).filter((code): code is string => Boolean(code))

    // 发票行是 JSON 快照，里面没有商品 sequence；打印页要按它排序（客户要求
    // 2026-08-18），而打印页是纯前端渲染碰不到数据库，所以在这里回查一次附上。
    // 见 lib/print/line-sort.ts
    //
    // ⚠️ 只对「按商品明细」的行有意义。Odoo 20260718 迁移进来的历史发票行是
    // `{orderId, orderCode, amount}`，没有 productId —— 对它们回查等于拿一串 undefined
    // 去查两次库、再给每行贴一对 null。生产库 14.8 万张历史发票走的都是这条路，
    // 所以这里先判型，按订单记的直接跳过回查。
    const rawLines = Array.isArray(invoice.lines) ? invoice.lines as Array<Record<string, unknown>> : []
    const hasProductLines = rawLines.some(l => l.productId != null)

    if (!hasProductLines) {
      return NextResponse.json(serializeApi({ ...invoice, saleOrderCodes }))
    }

    const seqMap = await fetchProductSequences(rawLines.map(l => l.productId as string | undefined))
    // 装货顺序（客户要求 2026-09-14，见 lib/print/line-sort.ts）：发票行 JSON 快照没存 uomId，
    // 只能按 productId 落回该商品基础单位的顺序（resolveUomSequence 的 fallback 分支），非精确匹配。
    const uomSeqMap = await fetchUomSequences(rawLines.map(l => ({ productId: l.productId as string | undefined, uomId: undefined })))
    const lines = rawLines.map(l => ({
      ...l,
      productSequence: l.productId ? (seqMap.get(l.productId as string) ?? null) : null,
      uomSequence: resolveUomSequence(uomSeqMap, l.productId as string | undefined, undefined),
    }))

    return NextResponse.json(serializeApi({ ...invoice, lines, saleOrderCodes }))
  } catch (error) {
    console.error('[GET /api/invoices/[id]]', error)
    return NextResponse.json({ error: '获取发票失败' }, { status: 500 })
  }
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const before = await prisma.invoice.findUnique({ where: { id } })
      if (!before) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      // SSOT: amountPaid 派生自 Payment 流水,禁止经此 PUT 旁路篡改(P1-6)。
      // 只接受白名单字段;amountDue 仅由 totalIncTax 与现有 amountPaid 重算,不收客户端值。
      const ALLOWED = ['name', 'customerName', 'paymentTerms', 'dueDate']
      const updateData: Record<string, unknown> = {}
      for (const k of ALLOWED) if (data[k] !== undefined) updateData[k] = data[k]
      const editsFinancialContent = data.lines !== undefined || ['subtotalExTax', 'totalTax', 'totalIncTax'].some(k => data[k] !== undefined)
      if (editsFinancialContent) {
        if (before.status !== 'DRAFT') return NextResponse.json({ error: '只有草稿发票可以编辑明细和金额' }, { status: 409 })
        if (data.lines === undefined) return NextResponse.json({ error: '金额必须通过发票明细计算，不能直接修改总额' }, { status: 400 })
        const [paymentCount, allocationCount] = await Promise.all([
          prisma.payment.count({ where: { invoiceId: id } }),
          prisma.creditNoteAllocation.count({ where: { invoiceId: id, kind: 'INVOICE' } }),
        ])
        if (paymentCount || allocationCount) return NextResponse.json({ error: '已有收款或贷记单抵扣的发票不能修改金额' }, { status: 409 })
      }
      if (data.lines !== undefined) {
        if (!Array.isArray(data.lines) || data.lines.length === 0 || data.lines.length > 1000) return NextResponse.json({ error: '发票明细不能为空，且最多 1000 行' }, { status: 400 })
        const rawLines = data.lines as Array<Record<string, unknown>>
        const orderBased = rawLines.every(line => ('orderCode' in line || 'orderId' in line) && !('productName' in line))
        if (orderBased) {
          const lines = rawLines.map(line => {
            const amount = Number(line.amount)
            if (!Number.isFinite(amount) || amount < 0 || amount > 1_000_000) throw Object.assign(new Error('销售单金额无效'), { status: 400 })
            return { ...line, amount: Math.round(amount * 100) / 100 }
          })
          const total = Math.round(lines.reduce((sum, line) => sum + Number(line.amount), 0) * 100) / 100
          updateData.lines = lines as object
          updateData.subtotalExTax = total; updateData.totalTax = 0; updateData.totalIncTax = total
        } else {
          let subtotalExTax = 0
          let totalTax = 0
          const lines = rawLines.map(line => {
            const qty = Number(line.qty ?? line.quantity)
            const unitPrice = Number(line.unitPrice)
            const rawTaxRate = Number(line.taxRate ?? 0)
            const taxRate = rawTaxRate > 1 ? rawTaxRate / 100 : rawTaxRate
            if (!Number.isFinite(qty) || qty <= 0 || qty > 100_000 || !Number.isFinite(unitPrice) || unitPrice < 0 || unitPrice > 1_000_000 || !Number.isFinite(taxRate) || taxRate < 0 || taxRate > 1) {
              throw Object.assign(new Error(`发票行数据无效：${String(line.productName ?? line.productId ?? '')}`), { status: 400 })
            }
            if (!String(line.productName ?? '').trim() && !String(line.productId ?? '').trim()) {
              throw Object.assign(new Error('商品名称不能为空'), { status: 400 })
            }
            const exTax = Math.round(qty * unitPrice * 100) / 100
            const taxAmount = Math.round(exTax * taxRate * 100) / 100
            subtotalExTax += exTax; totalTax += taxAmount
            return { ...line, qty, unitPrice, taxRate, subtotalExTax: exTax, taxAmount, subtotalIncTax: Math.round((exTax + taxAmount) * 100) / 100 }
          })
          subtotalExTax = Math.round(subtotalExTax * 100) / 100; totalTax = Math.round(totalTax * 100) / 100
          updateData.lines = lines as object
          updateData.subtotalExTax = subtotalExTax; updateData.totalTax = totalTax; updateData.totalIncTax = Math.round((subtotalExTax + totalTax) * 100) / 100
        }
      } else {
        for (const k of ['subtotalExTax', 'totalTax', 'totalIncTax']) if (data[k] !== undefined) updateData[k] = data[k]
      }
      // 状态流转:过账走 /post(生成凭证+回写 invoicedQty)、收款走 /payments;
      // 本接口只允许取消(CANCELLED),不接受 POSTED/PAID,避免绕过凭证生成(P1-6)。
      if (data.status !== undefined) {
        const s = String(data.status).toUpperCase()
        if (s !== 'CANCELLED') {
          return NextResponse.json({ error: '过账请用确认(Post)操作、收款请用收款操作,不可经此接口直接改状态' }, { status: 400 })
        }
        if (!['DRAFT', 'POSTED'].includes(String(before.status))) {
          return NextResponse.json({ error: `${before.status} 状态不可取消` }, { status: 400 })
        }
        updateData.status = 'CANCELLED'
      }
      const invoice = await prisma.$transaction(async tx => {
        await tx.$queryRaw`SELECT id FROM "Invoice" WHERE id = ${id} FOR UPDATE`
        const latest = await tx.invoice.findUnique({ where: { id } })
        if (!latest) throw Object.assign(new Error('发票不存在'), { status: 404 })
        if (editsFinancialContent && latest.status !== 'DRAFT') {
          throw Object.assign(new Error('发票已经过账，不能再编辑明细和金额'), { status: 409 })
        }
        if (editsFinancialContent) {
          const [paymentCount, allocationCount] = await Promise.all([
            tx.payment.count({ where: { invoiceId: id } }),
            tx.creditNoteAllocation.count({ where: { invoiceId: id, kind: 'INVOICE' } }),
          ])
          if (paymentCount || allocationCount) throw Object.assign(new Error('已有收款或贷记单抵扣的发票不能修改金额'), { status: 409 })
        }
        if (data.status !== undefined && !['DRAFT', 'POSTED'].includes(String(latest.status))) {
          throw Object.assign(new Error(`${latest.status} 状态不可取消`), { status: 400 })
        }
        const u = await tx.invoice.update({ where: { id }, data: updateData })
        // 改了总额 → 未付从明细重算（Payment + 贷记单抵扣），不再只减 amountPaid（20261014 L2）
        return editsFinancialContent ? recomputeInvoiceBalance(tx, id) : u
      })
      const changes = diffChanges(
        before as unknown as Record<string, unknown>,
        invoice as unknown as Record<string, unknown>,
        INVOICE_TRACKED_FIELDS,
      )
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'invoice', resourceId: id,
        detail: `更新发票: ${invoice.name || id}`,
        changes: Object.keys(changes).length > 0 ? changes : undefined })
      return NextResponse.json(serializeApi(invoice))
    } catch (error) {
      console.error('[PUT /api/invoices/[id]]', error)
      return NextResponse.json({ error: '更新发票失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.update' })
}

export async function DELETE(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      // SSOT: 已过账/已收款的发票有总账凭证且影响 AR,删除会留下悬挂凭证。
      // 只允许删 DRAFT/CANCELLED;已过账的请走取消(Cancelled)(P1-6)。
      const existing = await prisma.invoice.findUnique({ where: { id }, select: { status: true, name: true } })
      if (!existing) return NextResponse.json({ error: '发票不存在' }, { status: 404 })
      if (!['DRAFT', 'CANCELLED'].includes(String(existing.status))) {
        return NextResponse.json({ error: `${existing.status} 状态的发票不可删除,请改用取消(Cancelled)` }, { status: 400 })
      }
      await prisma.invoice.delete({ where: { id } })
      await writeLog({ userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'DELETE', resource: 'invoice', resourceId: id,
        detail: `删除发票: ${existing.name || id}` })
      return NextResponse.json({ ok: true })
    } catch (error) {
      console.error('[DELETE /api/invoices/[id]]', error)
      return NextResponse.json({ error: '删除发票失败' }, { status: 500 })
    }
  }, { require: 'finance.invoice.delete' })
}
