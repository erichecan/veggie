import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, type MatchKeyDef, importOptionsFromBody,
} from '@/lib/import/bulk-import-engine'
import { resolveContactCommonFields, describeContactRowError, parseActiveStatus, type ContactCommonFields } from '@/lib/import/contact-fields'

/**
 * POST /api/suppliers/bulk — 供应商批量导入(CSV，20261003 改走全站通用的
 * lib/import/bulk-import-engine.ts，与商品/客户同款引擎)
 * body: { rows: [{ name*, externalId?, phone?, email?, address?, city?, zip?,
 *   vatNumber?, supplierPaymentTerm?, vendorTaxRate?, notes? }], rowOffset? }
 *
 * 供应商 = Customer{isVendor:true}，全库没有独立的 Supplier 表（见 lib/export/registry.ts
 * 同款注释）。字段解析复用 lib/import/contact-fields.ts，与 customers/bulk 保持同一套规则。
 *
 * 匹配：按供应商编号 → externalId 精确匹配更新**已有供应商**；都没匹配上则按名字在
 * **供应商**里判重，撞了跳过(不覆盖)。更新时只覆盖本行提供了非空值的字段。
 *
 * ⛔ 客户/供应商彻底分开(20261007 客户要求)：这里只认、只改 isVendor 的档案，绝不碰
 * 客户档案——跟客户同名也照样新建一条独立的供应商(各自的编号、各自改名互不影响)。
 * (20261006 那版"同名客户直接标成供应商"会造成一条记录两种身份，已撤掉。)
 */

const MAX_ROWS_PER_REQUEST = 500

interface ResolvedSupplierRow extends ContactCommonFields {
  rowLabel: string
  name: string
  /** 供应商编号(= Customer.customerNo，与客户共用一个序列)，填了就按它精确匹配更新 */
  customerNo?: number
  /** 状态列 Active/Inactive(停用 = 归档)；空 = 不改 */
  isActive?: boolean
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
        { field: 'customerNo', get: r => r.customerNo },
        { field: 'externalId', get: r => r.externalId },
      ]

      const result = await runBulkImport<Record<string, unknown>, ResolvedSupplierRow>({
        rawRows,
        rowOffset,
        // 试运行 / 导入历史(20261008)：dryRun、importId、fileName、batch 由导入弹窗带上来
        ...importOptionsFromBody(data),
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const row: ResolvedSupplierRow = { rowLabel, name, ...resolveContactCommonFields(r) }
          if (r.customerNo !== undefined) {
            const customerNo = Number(r.customerNo)
            if (!Number.isSafeInteger(customerNo) || customerNo <= 0) {
              warn(`${rowLabel}: invalid vendor number '${String(r.customerNo)}', skipped`)
              return null
            }
            row.customerNo = customerNo
          }

          const status = parseActiveStatus(r.isActive)
          if (status.invalid) warn(`${rowLabel}: status '${String(r.isActive)}' not recognized (use Active / Inactive), ignored`)
          row.isActive = status.value

          const supplierPaymentTerm = str(r.supplierPaymentTerm, 100)
          if (supplierPaymentTerm) row.supplierPaymentTerm = supplierPaymentTerm

          const vendorTaxRate = vendorTaxRateFromRaw(r.vendorTaxRate)
          if (vendorTaxRate.invalid) warn(`${rowLabel}: vendorTaxRate out of range (0-1), ignored`)
          row.vendorTaxRate = vendorTaxRate.value

          return row
        },

        async findMatchCandidates(keyValues) {
          // 只在供应商档案里找：编号/ID 对上的若是客户档案，按"没找到"处理
          const filters = [
            ...(keyValues.customerNo?.length ? [{ customerNo: { in: keyValues.customerNo as number[] } }] : []),
            ...(keyValues.externalId?.length ? [{ externalId: { in: keyValues.externalId as string[] } }] : []),
          ]
          if (!filters.length) return []
          const found = await prisma.customer.findMany({
            where: { isVendor: true, OR: filters },
            orderBy: { createdAt: 'asc' },
          })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          // 只跟已有供应商查重；与客户同名不算重复(客户/供应商是两条独立档案)
          const existing = await prisma.customer.findMany({ where: { isVendor: true }, select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          // 填了编号却没对上 = 多半是填错了，不能悄悄当新供应商建一条(同 customers/bulk)
          if (row.customerNo !== undefined && !existingId) {
            throw new Error(`Vendor No ${row.customerNo} not found; leave it blank to create a vendor`)
          }
          if (existingId) {
            const updateData: Record<string, unknown> = { name: row.name, updatedBy: user.name || user.email }
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
            if (row.isActive !== undefined) updateData.isActive = row.isActive
            const updated = await tx.customer.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.customer.update>[0]['data'],
            })
            return { id: updated.id }
          }
          // externalId 全库唯一：Odoo 导出的 ID 可能已经挂在同一联系人的「客户」档案上——
          // 新供应商就不带这个 ID(不报错、不碰客户)，提示一句
          let externalId = row.externalId ?? null
          let warning: string | undefined
          if (externalId && await tx.customer.findUnique({ where: { externalId }, select: { id: true } })) {
            warning = `${row.rowLabel}: ID '${externalId}' already belongs to a customer record; vendor created without it`
            externalId = null
          }
          const created = await tx.customer.create({
            data: {
              name: row.name,
              externalId,
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
              isActive: row.isActive ?? true,
              updatedBy: user.name || user.email,
            },
          })
          return { id: created.id, warning }
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
