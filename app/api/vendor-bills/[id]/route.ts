import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postVendorBillToJournal, postVendorPaymentToJournal, postVendorPaymentReversalToJournal } from '@/lib/accounting'
import { recomputeVendorBillBalance } from '@/lib/finance/vendor-bill-balance'
import { reconcileVendorBill, type ReconciliationBillLine, type ReconciliationPoLine } from '@/lib/vendor-bill-reconciliation'
import { normalizeSupplierInvoiceRef } from '@/lib/vendor-bill-fields'

/**
 * /api/vendor-bills/[id]
 * ============================================================================
 * GET — 账单详情，含 reconciliation（供应商三单核销，见 lib/vendor-bill-reconciliation.ts）
 * PUT — 状态流转 + 登记付款:
 *   状态机:DRAFT → POSTED → PAID;DRAFT/POSTED → CANCELLED
 *   body: { status?, amountPaid?, notes?, supplierInvoiceRef? }
 *   amountPaid 为累计已付金额,amountDue 服务端重算;POSTED 下付清自动转 PAID
 */

function round2(n: number): number {
  return Math.round(n * 100) / 100
}

export async function GET(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async () => {
    try {
      const { id } = await ctx.params
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const bill = await p.vendorBill.findUnique({ where: { id } })
      if (!bill) return NextResponse.json({ error: '账单不存在' }, { status: 404 })

      let poLines: ReconciliationPoLine[] = []
      if (bill.purchaseOrderId) {
        const lines = await p.purchaseOrderLine.findMany({
          where: { purchaseOrderId: bill.purchaseOrderId },
          select: { productId: true, orderedQty: true, receivedQty: true },
        })
        poLines = lines.map((l: { productId: string | null; orderedQty: unknown; receivedQty: unknown }) => ({
          productId: l.productId ?? '',
          orderedQty: Number(l.orderedQty),
          receivedQty: Number(l.receivedQty),
        }))
      }
      const billLines: ReconciliationBillLine[] = (Array.isArray(bill.lines) ? bill.lines : []).map(
        (l: { productId?: string; productName?: string; qty?: unknown }) => ({
          productId: l.productId ?? '',
          productName: l.productName ?? '',
          billedQty: Number(l.qty ?? 0),
        }),
      )
      const reconciliation = reconcileVendorBill(poLines, billLines)

      return NextResponse.json({ ...serializeApi(bill), reconciliation })
    } catch (error) {
      console.error('[GET /api/vendor-bills/[id]]', error)
      return NextResponse.json({ error: '获取账单失败' }, { status: 500 })
    }
  }, { require: 'finance.vendor_bill.read' })
}

export async function PUT(req: Request, ctx: { params: Promise<{ id: string }> }) {
  return withAuth(req, async (user) => {
    try {
      const { id } = await ctx.params
      const data = await req.json()
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const p = prisma as any
      const existing = await p.vendorBill.findUnique({ where: { id } })
      if (!existing) return NextResponse.json({ error: '账单不存在' }, { status: 404 })

      const updateData: Record<string, unknown> = {}
      const totalIncTax = Number(existing.totalIncTax)
      const detail: string[] = []
      // 目标「累计已付」。amountPaid/amountDue 本身不在这里写：差额落一笔 VendorPayment 流水，
      // 余额由 recomputeVendorBillBalance 从流水重算（20261014 L2）
      let targetPaid: number | null = null

      if (data.amountPaid !== undefined) {
        const paid = Number(data.amountPaid)
        if (!Number.isFinite(paid) || paid < 0 || paid > totalIncTax + 0.005) {
          return NextResponse.json({ error: '已付金额无效(0 ~ 含税总额)' }, { status: 400 })
        }
        targetPaid = round2(paid)
        detail.push(`登记已付 €${round2(paid)}`)
      }

      if (data.status !== undefined) {
        const s = String(data.status).toUpperCase()
        const validTransitions: Record<string, string[]> = {
          DRAFT: ['POSTED', 'CANCELLED'],
          POSTED: ['PAID', 'CANCELLED'],
        }
        const allowed = validTransitions[String(existing.status)] ?? []
        if (!allowed.includes(s)) {
          return NextResponse.json({ error: `无法从 ${existing.status} 转为 ${s}` }, { status: 400 })
        }
        updateData.status = s
        if (s === 'POSTED') updateData.postedAt = new Date()
        if (s === 'PAID') {
          // 「全额付清」：补一笔把累计已付拉到总额的流水，状态由重算推进
          delete updateData.status
          targetPaid = round2(totalIncTax)
        }
        detail.push(`状态 ${existing.status} → ${s}`)
      }

      if (data.notes !== undefined) {
        updateData.notes = data.notes ? String(data.notes).trim().slice(0, 1000) : null
      }

      if (data.supplierInvoiceRef !== undefined) {
        updateData.supplierInvoiceRef = normalizeSupplierInvoiceRef(data.supplierInvoiceRef)
        detail.push(`供应商发票参考号 → ${updateData.supplierInvoiceRef ?? '(清空)'}`)
      }

      if (Object.keys(updateData).length === 0 && targetPaid === null) {
        return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
      }

      // SSOT: 过账/付款同步生成总账凭证(此前 postVendorBillToJournal 是死函数,真实 AP 入账无凭证 — P1-6)
      const willPost = updateData.status === 'POSTED'
      const bill = await p.$transaction(async (tx: typeof p) => {
        let updated = Object.keys(updateData).length > 0
          ? await tx.vendorBill.update({ where: { id }, data: updateData })
          : existing
        // 差额按**流水合计**算，不按缓存的 amountPaid（缓存可能已经漂了）
        const paidSum = await tx.vendorPayment.aggregate({ where: { vendorBillId: id }, _sum: { amount: true } })
        const paymentDelta = targetPaid === null ? 0 : round2(targetPaid - Number(paidSum._sum.amount ?? 0))
        if (targetPaid !== null && Math.abs(paymentDelta) > 0.005 && !['POSTED', 'PAID'].includes(String(updated.status))) {
          throw Object.assign(new Error('只有已过账的账单可以登记付款'), { status: 400 })
        }
        if (willPost) {
          const e = await postVendorBillToJournal(tx, {
            id: existing.id, name: existing.name, supplierId: existing.supplierId,
            subtotalExTax: existing.subtotalExTax, totalTax: existing.totalTax, totalIncTax: existing.totalIncTax,
            purchaseOrderId: existing.purchaseOrderId ?? null,
          }, user.userId)
          if (e) detail.push(`凭证 ${e.name}`)
        }
        if (paymentDelta > 0.005) {
          // ⚠️ 这条路径（PUT 传累计已付 / 「全额付清」按钮）保留是为了不破坏既有调用，
          // 但它**必须同样落一笔流水** —— 否则 `amountPaid` 与 VendorPayment 会各说各话，
          // 而分批付款的全部价值就在那张流水表上（台账 G2）。
          // 新代码请用 POST /api/vendor-bills/:id/payments（传本笔金额，服务端累加）。
          const vp = await tx.vendorPayment.create({
            data: {
              vendorBillId: id, supplierId: existing.supplierId, amount: paymentDelta,
              method: 'other', note: '经账单更新接口登记（未指定付款方式）',
              createdBy: user.name ?? user.email,
            },
          })
          const e = await postVendorPaymentToJournal(tx, {
            // 幂等键用流水 id：原先拼的是 `${billId}-pay-${累计金额}`，
            // 同一账单先付 100 → 冲销 → 再付 100 会撞出同一个 sourceId
            id: vp.id, billName: existing.name, supplierId: existing.supplierId, amount: paymentDelta,
          }, user.userId)
          if (e) detail.push(`付款凭证 ${e.name}`)
        } else if (paymentDelta < -0.005) {
          // 调低累计已付 = 冲销一部分付款：落一笔负数流水 + 反向凭证（以前只改字段，流水和总账都不知道）
          const vp = await tx.vendorPayment.create({
            data: {
              vendorBillId: id, supplierId: existing.supplierId, amount: paymentDelta,
              method: 'other', note: '经账单更新接口调低已付（冲销）',
              createdBy: user.name ?? user.email,
            },
          })
          const e = await postVendorPaymentReversalToJournal(tx, {
            id: vp.id, billName: existing.name, supplierId: existing.supplierId, amount: paymentDelta,
          }, user.userId)
          if (e) detail.push(`冲销凭证 ${e.name}`)
        }
        if (targetPaid !== null || updateData.status !== undefined) {
          updated = await recomputeVendorBillBalance(tx, id)
        }
        return updated
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'vendor_bill', resourceId: id,
        detail: `${existing.name}: ${detail.join('; ')}`,
      })
      return NextResponse.json(serializeApi(bill))
    } catch (error) {
      const st = (error as { status?: number })?.status
      if (st && st >= 400 && st < 500) {
        return NextResponse.json({ error: (error as Error).message }, { status: st })
      }
      console.error('[PUT /api/vendor-bills/[id]]', error)
      return NextResponse.json({ error: '更新账单失败' }, { status: 500 })
    }
  }, { require: 'finance.vendor_bill.update' })
}
