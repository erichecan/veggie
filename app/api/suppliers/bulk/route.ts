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
 *
 * 同名的「纯客户」(20261006 客户反馈：导入供应商后列表还是原来那 20 个)：
 * 客户和供应商是同一张表，从 Odoo 导出的供应商很多本来就作为客户存在(Odoo 里是同一个
 * 联系人)。以前按名字判重时把它们一律当撞名跳过，又不打 isVendor 标记，于是整份导入
 * 基本全进了"重名跳过"，供应商列表纹丝不动。现在：名字唯一对上一条还不是供应商的记录，
 * 就把它标成供应商(同时仍是客户)，只补它空着的联系字段、不覆盖客户已有资料；同名记录
 * 不止一条时不猜，跳过并提示用 ID 列指定；同名的已经是供应商 = 真重复，照旧跳过。
 */

const MAX_ROWS_PER_REQUEST = 500

interface ResolvedSupplierRow extends ContactCommonFields {
  rowLabel: string
  name: string
  /** 供应商编号(= Customer.customerNo，与客户共用一个序列)，填了就按它精确匹配更新 */
  customerNo?: number
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

      // ── 同名的纯客户(非供应商)：唯一一条才并入，见文件头说明 ──
      const batchNameKeys = [...new Set(
        (rawRows as Array<Record<string, unknown>>).map(r => str(r?.name, 200)?.toLowerCase()).filter((n): n is string => !!n),
      )]
      const sameNameRecords = batchNameKeys.length === 0 ? [] : await prisma.customer.findMany({
        where: { name: { in: batchNameKeys, mode: 'insensitive' } },
        select: { id: true, name: true, isVendor: true, isActive: true },
        orderBy: { createdAt: 'asc' },
      })
      const recordsByName = new Map<string, typeof sameNameRecords>()
      for (const c of sameNameRecords) {
        const k = c.name.toLowerCase()
        recordsByName.set(k, [...(recordsByName.get(k) ?? []), c])
      }
      /** nameKey → 可并入的那条纯客户 */
      const customerOnlyByName = new Map<string, { id: string; isActive: boolean }>()
      /** nameKey → 同名纯客户条数(>1 时不猜) */
      const ambiguousNames = new Map<string, number>()
      for (const [k, list] of recordsByName) {
        if (list.some(c => c.isVendor)) continue // 已有同名供应商 = 真重复，交给引擎按撞名跳过
        if (list.length === 1) customerOnlyByName.set(k, { id: list[0].id, isActive: list[0].isActive })
        else ambiguousNames.set(k, list.length)
      }
      const nameMatchedIds = new Set([...customerOnlyByName.values()].map(c => c.id))
      /** externalId 命中的记录 id —— 用来区分本行是按 ID 还是按名字匹配上的 */
      const externalIdHitIds = new Map<string, string>()

      const matchKeys: MatchKeyDef<ResolvedSupplierRow>[] = [
        { field: 'customerNo', get: r => r.customerNo },
        { field: 'externalId', get: r => r.externalId },
        // 只给"确实有唯一同名纯客户"的行出值，否则引擎会对每个新供应商都报一条 not found
        { field: 'customerNameKey', get: r => (customerOnlyByName.has(r.name.toLowerCase()) ? r.name.toLowerCase() : undefined) },
      ]

      const result = await runBulkImport<Record<string, unknown>, ResolvedSupplierRow>({
        rawRows,
        rowOffset,
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const dupCount = ambiguousNames.get(name.toLowerCase())
          if (dupCount && !str(r.externalId, 100)) {
            warn(`${rowLabel}: ${dupCount} existing customers are named '${name}', not sure which one this vendor is — skipped; fill the ID column to pick one`)
          }
          const row: ResolvedSupplierRow = { rowLabel, name, ...resolveContactCommonFields(r) }
          if (r.customerNo !== undefined) {
            const customerNo = Number(r.customerNo)
            if (!Number.isSafeInteger(customerNo) || customerNo <= 0) {
              warn(`${rowLabel}: invalid vendor number '${String(r.customerNo)}', skipped`)
              return null
            }
            row.customerNo = customerNo
          }

          const supplierPaymentTerm = str(r.supplierPaymentTerm, 100)
          if (supplierPaymentTerm) row.supplierPaymentTerm = supplierPaymentTerm

          const vendorTaxRate = vendorTaxRateFromRaw(r.vendorTaxRate)
          if (vendorTaxRate.invalid) warn(`${rowLabel}: vendorTaxRate out of range (0-1), ignored`)
          row.vendorTaxRate = vendorTaxRate.value

          return row
        },

        async findMatchCandidates(keyValues) {
          const candidates: Array<Record<string, unknown> & { id: string }> = []
          if (keyValues.customerNo?.length) {
            const byNo = await prisma.customer.findMany({
              where: { customerNo: { in: keyValues.customerNo as number[] } },
              orderBy: { createdAt: 'asc' },
            })
            candidates.push(...(byNo as unknown as Array<Record<string, unknown> & { id: string }>))
          }
          if (keyValues.externalId?.length) {
            // 跟 customers/bulk 查同一张表(没有独立 Supplier 表)；externalId 全库唯一，
            // 不会误匹配到纯客户记录。
            const found = await prisma.customer.findMany({
              where: { externalId: { in: keyValues.externalId as string[] } },
              orderBy: { createdAt: 'asc' },
            })
            for (const c of found) if (c.externalId) externalIdHitIds.set(c.externalId, c.id)
            candidates.push(...(found as unknown as Array<Record<string, unknown> & { id: string }>))
          }
          for (const k of (keyValues.customerNameKey ?? []) as string[]) {
            const hit = customerOnlyByName.get(k)
            if (hit) candidates.push({ id: hit.id, customerNameKey: k })
          }
          return candidates
        },

        async findExistingNames() {
          // 与全库现有客户/供应商名一起查重——避免同名各建一条、事后分不清(同 customers/bulk)
          const existing = await prisma.customer.findMany({ select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          // 填了编号却没对上 = 多半是填错了，不能悄悄当新供应商建一条(同 customers/bulk)
          if (row.customerNo !== undefined && !existingId) {
            throw new Error(`Vendor No ${row.customerNo} not found; leave it blank to create a vendor`)
          }
          const viaName = existingId !== null && nameMatchedIds.has(existingId)
            && row.customerNo === undefined
            && !(row.externalId && externalIdHitIds.get(row.externalId) === existingId)
          if (existingId && viaName) {
            // 按名字并入的纯客户：只打供应商标记 + 补空字段，客户已有的电话/地址等一律不动
            const cur = await tx.customer.findUniqueOrThrow({
              where: { id: existingId },
              select: { name: true, isActive: true, externalId: true, phone: true, email: true, address: true, city: true, zip: true, vatNumber: true, notes: true },
            })
            const updateData: Record<string, unknown> = { isVendor: true, updatedBy: user.name || user.email }
            if (row.externalId !== undefined && !cur.externalId) updateData.externalId = row.externalId
            if (row.phone !== undefined && !cur.phone) updateData.phone = row.phone
            if (row.email !== undefined && !cur.email) updateData.email = row.email
            if (row.address !== undefined && !cur.address) updateData.address = row.address
            if (row.city !== undefined && !cur.city) updateData.city = row.city
            if (row.zip !== undefined && !cur.zip) updateData.zip = row.zip
            if (row.vatNumber !== undefined && !cur.vatNumber) updateData.vatNumber = row.vatNumber
            if (row.notes !== undefined && !cur.notes) updateData.notes = row.notes
            // 采购专属字段，客户身份下本来就没有意义，有值就写
            if (row.supplierPaymentTerm !== undefined) updateData.supplierPaymentTerm = row.supplierPaymentTerm
            if (row.vendorTaxRate !== undefined) updateData.vendorTaxRate = row.vendorTaxRate
            const updated = await tx.customer.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.customer.update>[0]['data'],
            })
            const archivedNote = cur.isActive ? '' : ' — it is archived, so it only shows under the Archived filter'
            return {
              id: updated.id,
              warning: `${row.rowLabel}: existing customer '${cur.name}' marked as a vendor too (its customer details kept, only empty fields filled)${archivedNote}`,
            }
          }
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
