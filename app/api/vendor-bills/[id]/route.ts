import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { postVendorBillToJournal, postVendorPaymentToJournal } from '@/lib/accounting'

/**
 * /api/vendor-bills/[id]
 * ============================================================================
 * GET — 账单详情
 * PUT — 状态流转 + 登记付款:
 *   状态机:DRAFT → POSTED → PAID;DRAFT/POSTED → CANCELLED
 *   body: { status?, amountPaid?, notes? }
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
      return NextResponse.json(serializeApi(bill))
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

      if (data.amountPaid !== undefined) {
        const paid = Number(data.amountPaid)
        if (!Number.isFinite(paid) || paid < 0 || paid > totalIncTax + 0.005) {
          return NextResponse.json({ error: '已付金额无效(0 ~ 含税总额)' }, { status: 400 })
        }
        updateData.amountPaid = round2(paid)
        updateData.amountDue = round2(totalIncTax - paid)
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
          updateData.paidAt = new Date()
          updateData.amountPaid = totalIncTax
          updateData.amountDue = 0
        }
        detail.push(`状态 ${existing.status} → ${s}`)
      } else if (data.amountPaid !== undefined && String(existing.status) === 'POSTED') {
        // 付清自动转 PAID
        const due = Number(updateData.amountDue)
        if (due <= 0.005) {
          updateData.status = 'PAID'
          updateData.paidAt = new Date()
          detail.push('已付清,自动转 PAID')
        }
      }

      if (data.notes !== undefined) {
        updateData.notes = data.notes ? String(data.notes).trim().slice(0, 1000) : null
      }

      if (Object.keys(updateData).length === 0) {
        return NextResponse.json({ error: '没有可更新的字段' }, { status: 400 })
      }

      // SSOT: 过账/付款同步生成总账凭证(此前 postVendorBillToJournal 是死函数,真实 AP 入账无凭证 — P1-6)
      const willPost = updateData.status === 'POSTED'
      const oldPaid = Number(existing.amountPaid)
      const newPaid = updateData.amountPaid !== undefined ? Number(updateData.amountPaid) : oldPaid
      const paymentDelta = round2(newPaid - oldPaid)

      const bill = await p.$transaction(async (tx: typeof p) => {
        const updated = await tx.vendorBill.update({ where: { id }, data: updateData })
        if (willPost) {
          const e = await postVendorBillToJournal(tx, {
            id: existing.id, name: existing.name, supplierId: existing.supplierId,
            subtotalExTax: existing.subtotalExTax, totalTax: existing.totalTax, totalIncTax: existing.totalIncTax,
          }, user.userId)
          if (e) detail.push(`凭证 ${e.name}`)
        }
        if (paymentDelta > 0.005) {
          const e = await postVendorPaymentToJournal(tx, {
            id: `${id}-pay-${newPaid}`, billName: existing.name, supplierId: existing.supplierId, amount: paymentDelta,
          }, user.userId)
          if (e) detail.push(`付款凭证 ${e.name}`)
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
      console.error('[PUT /api/vendor-bills/[id]]', error)
      return NextResponse.json({ error: '更新账单失败' }, { status: 500 })
    }
  }, { require: 'finance.vendor_bill.update' })
}
