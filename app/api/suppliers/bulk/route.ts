import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'

/**
 * POST /api/suppliers/bulk — 供应商批量导入(CSV)
 * body: { rows: [{ name*, phone?, email?, address?, city?, zip?, vatNumber?, supplierPaymentTerm?, vendorTaxRate?, notes? }] }
 * 重名(不区分大小写，与全库客户+供应商一起查重)跳过,一次最多 500 行。
 *
 * 供应商 = Customer{isVendor:true}，全库没有独立的 Supplier 表（见 lib/export/registry.ts
 * 的同款注释）。这个端点跟 /api/customers/bulk 是姊妹端点：字段集按供应商场景取舍
 * （没有 paymentTerm/salesman 这类客户专属字段，换成 supplierPaymentTerm/vendorTaxRate），
 * 但查重/分批策略逐字照抄，保持两个导入入口的行为一致，用户不用记两套规则。
 */

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const rows = Array.isArray(data.rows) ? data.rows : []
      if (rows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rows.length > 500) return NextResponse.json({ error: '一次最多导入 500 行' }, { status: 400 })

      const taxRate = (v: unknown): number | null => {
        if (v === null || v === undefined || v === '') return null
        const n = Number(v)
        return Number.isFinite(n) && n >= 0 && n <= 1 ? n : null
      }

      const cleaned = rows
        .map((r: Record<string, unknown>) => ({
          // phone/email/address/zip/vatNumber 在 schema 中非空(默认 "")，不可传 null,
          // 与 /api/customers/bulk 同款处理
          name: String(r.name ?? '').trim().slice(0, 200),
          phone: r.phone ? String(r.phone).trim().slice(0, 50) : '',
          email: r.email ? String(r.email).trim().slice(0, 200) : '',
          address: r.address ? String(r.address).trim().slice(0, 500) : '',
          city: r.city ? String(r.city).trim().slice(0, 100) : null,
          zip: r.zip ? String(r.zip).trim().slice(0, 20) : '',
          vatNumber: r.vatNumber ? String(r.vatNumber).trim().slice(0, 50) : '',
          supplierPaymentTerm: r.supplierPaymentTerm ? String(r.supplierPaymentTerm).trim().slice(0, 100) : null,
          vendorTaxRate: taxRate(r.vendorTaxRate),
          notes: r.notes ? String(r.notes).trim().slice(0, 1000) : null,
          isVendor: true,
          isCustomer: false,
        }))
        .filter((r: { name: string }) => r.name.length > 0)

      if (cleaned.length === 0) {
        return NextResponse.json({ error: '没有有效行(name 必填)' }, { status: 400 })
      }

      // 重名跳过:与全库现有客户/供应商名 + 本批次内部去重(不区分大小写)——跟
      // /api/customers/bulk 用同一张 Customer 表查重，避免同名各建一条、事后分不清
      const existing = await prisma.customer.findMany({ select: { name: true } })
      const taken = new Set(existing.map(c => c.name.toLowerCase()))
      const toCreate: typeof cleaned = []
      const skipped: string[] = []
      for (const r of cleaned) {
        const key = r.name.toLowerCase()
        if (taken.has(key)) { skipped.push(r.name); continue }
        taken.add(key)
        toCreate.push(r)
      }

      if (toCreate.length > 0) {
        await prisma.customer.createMany({ data: toCreate })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'supplier', resourceId: 'bulk',
        detail: `批量导入供应商:成功 ${toCreate.length},重名跳过 ${skipped.length}`,
      })
      return NextResponse.json({ created: toCreate.length, skipped })
    } catch (error) {
      console.error('[POST /api/suppliers/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.customer.bulk_import' })
}
