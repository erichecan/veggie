import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, type MatchKeyDef,
} from '@/lib/import/bulk-import-engine'
import { resolveContactCommonFields, describeContactRowError, type ContactCommonFields } from '@/lib/import/contact-fields'

/**
 * POST /api/suppliers/bulk — 供应商批量导入(CSV，20261003 改走全站通用的
 * lib/import/bulk-import-engine.ts，与商品/客户同款引擎)
 * body: { rows: [{ name*, externalId?, phone?, email?, address?, city?, zip?,
 *   vatNumber?, supplierPaymentTerm?, vendorTaxRate?, notes? }], rowOffset? }
 *
 * 供应商 = Customer{isVendor:true}，全库没有独立的 Supplier 表（见 lib/export/registry.ts
 * 同款注释）。字段解析复用 lib/import/contact-fields.ts，与 customers/bulk 保持同一套规则。
 *
 * 新增能力(原来只会创建，撞名就跳过)：按 externalId 精确匹配更新已有供应商，都没
 * 匹配上则落回按名字判重，撞了跳过(不覆盖)。更新时只覆盖本行提供了非空值的字段。
 */

const MAX_ROWS_PER_REQUEST = 500

interface ResolvedSupplierRow extends ContactCommonFields {
  rowLabel: string
  name: string
  supplierPaymentTerm?: string
  vendorTaxRate?: number
}

function vendorTaxRateFromRaw(v: unknown): { value: number | undefined; invalid: boolean } {
  if (v === null || v === undefined || v === '') return { value: undefined, invalid: false }
  const n = Number(v)
  if (!Number.isFinite(n) || n < 0 || n > 1) return { value: undefined, invalid: true }
  return { value: n, invalid: false }
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const rawRows = Array.isArray(data.rows) ? data.rows : []
      if (rawRows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rawRows.length > MAX_ROWS_PER_REQUEST) {
        return NextResponse.json({ error: `单次请求最多 ${MAX_ROWS_PER_REQUEST} 行(导入弹窗会自动分批提交)` }, { status: 400 })
      }
      const rowOffset = Number.isInteger(data.rowOffset) && data.rowOffset >= 0 ? data.rowOffset as number : 0

      const matchKeys: MatchKeyDef<ResolvedSupplierRow>[] = [
        { field: 'externalId', get: r => r.externalId },
      ]

      const result = await runBulkImport<Record<string, unknown>, ResolvedSupplierRow>({
        rawRows,
        rowOffset,
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const row: ResolvedSupplierRow = { rowLabel, name, ...resolveContactCommonFields(r) }

          const supplierPaymentTerm = str(r.supplierPaymentTerm, 100)
          if (supplierPaymentTerm) row.supplierPaymentTerm = supplierPaymentTerm

          const vendorTaxRate = vendorTaxRateFromRaw(r.vendorTaxRate)
          if (vendorTaxRate.invalid) warn(`${rowLabel}: vendorTaxRate out of range (0-1), ignored`)
          row.vendorTaxRate = vendorTaxRate.value

          return row
        },

        async findMatchCandidates(keyValues) {
          if (!keyValues.externalId?.length) return []
          // 跟 customers/bulk 查同一张表(没有独立 Supplier 表)；externalId 全库唯一，
          // 不会误匹配到纯客户记录。
          const found = await prisma.customer.findMany({
            where: { externalId: { in: keyValues.externalId as string[] } },
            orderBy: { createdAt: 'asc' },
          })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          // 与全库现有客户/供应商名一起查重——避免同名各建一条、事后分不清(同 customers/bulk)
          const existing = await prisma.customer.findMany({ select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          if (existingId) {
            const updateData: Record<string, unknown> = { name: row.name, isVendor: true, updatedBy: user.name || user.email }
            if (row.externalId !== undefined) updateData.externalId = row.externalId
            if (row.phone !== undefined) updateData.phone = row.phone
            if (row.email !== undefined) updateData.email = row.email
            if (row.address !== undefined) updateData.address = row.address
            if (row.city !== undefined) updateData.city = row.city
            if (row.zip !== undefined) updateData.zip = row.zip
            if (row.vatNumber !== undefined) updateData.vatNumber = row.vatNumber
            if (row.notes !== undefined) updateData.notes = row.notes
            if (row.supplierPaymentTerm !== undefined) updateData.supplierPaymentTerm = row.supplierPaymentTerm
            if (row.vendorTaxRate !== undefined) updateData.vendorTaxRate = row.vendorTaxRate
            const updated = await tx.customer.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.customer.update>[0]['data'],
            })
            return { id: updated.id }
          }
          const created = await tx.customer.create({
            data: {
              name: row.name,
              externalId: row.externalId ?? null,
              phone: row.phone ?? '',
              email: row.email ?? '',
              address: row.address ?? '',
              city: row.city ?? null,
              zip: row.zip ?? '',
              vatNumber: row.vatNumber ?? '',
              supplierPaymentTerm: row.supplierPaymentTerm ?? null,
              vendorTaxRate: row.vendorTaxRate ?? null,
              notes: row.notes ?? null,
              isVendor: true,
              isCustomer: false,
              updatedBy: user.name || user.email,
            },
          })
          return { id: created.id }
        },

        describeRowError(e, row) {
          const msg = describeContactRowError('supplier', isUniqueConstraintError(e), isTransactionTimeoutError(e), row.externalId)
          return msg === 'unknown error' ? lastErrorLine(e) : msg
        },

        auditLog: { userId: user.userId, userEmail: user.email, userName: user.name, resource: 'supplier', resourceLabel: '供应商' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/suppliers/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.customer.bulk_import' })
}
