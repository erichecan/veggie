import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, type MatchKeyDef,
} from '@/lib/import/bulk-import-engine'
import { resolveContactCommonFields, describeContactRowError, type ContactCommonFields } from '@/lib/import/contact-fields'

/**
 * POST /api/customers/bulk — 客户批量导入(CSV，20261003 改走全站通用的
 * lib/import/bulk-import-engine.ts，与商品/供应商同款引擎)
 * body: { rows: [{ name*, externalId?, phone?, email?, address?, city?, zip?,
 *   paymentTerm?, salesman?, vatNumber?, notes? }], rowOffset? }
 *
 * 新增能力(原来只会创建，撞名就跳过)：按 externalId 精确匹配更新已有客户——
 * 跟商品模块一致的"导出 → Excel 改 → 重新导入"路径。都没传/没匹配上则落回
 * 按名字大小写不敏感判重，撞了跳过(不覆盖)。更新时只覆盖本行提供了非空值的字段。
 */

const MAX_ROWS_PER_REQUEST = 500
const VALID_TERMS = new Set(['cash', 'weekly', 'monthly'])

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(/g, '(')
}

interface ResolvedCustomerRow extends ContactCommonFields {
  rowLabel: string
  name: string
  paymentTerm?: string
  salesUserId?: string | null
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

      // salesman 列是导入文件里的姓名文本,需要匹配到真实的销售类用户账号(销售/销售助理/外聘销售)才能写 salesUserId
      const SALES_ROLES = ['OPERATOR', 'SALES', 'EXTERNAL_SALES'] as const
      const salesUsers = await prisma.user.findMany({
        where: { OR: [{ role: { in: [...SALES_ROLES] } }, { roles: { hasSome: [...SALES_ROLES] } }] },
        select: { id: true, name: true },
      })
      const salesUserByName = new Map(salesUsers.map(u => [normalizeName(u.name), u.id]))

      const matchKeys: MatchKeyDef<ResolvedCustomerRow>[] = [
        { field: 'externalId', get: r => r.externalId },
      ]

      const result = await runBulkImport<Record<string, unknown>, ResolvedCustomerRow>({
        rawRows,
        rowOffset,
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const row: ResolvedCustomerRow = { rowLabel, name, ...resolveContactCommonFields(r) }

          const paymentTermRaw = str(r.paymentTerm, 20)?.toLowerCase()
          if (paymentTermRaw) {
            if (VALID_TERMS.has(paymentTermRaw)) row.paymentTerm = paymentTermRaw
            else warn(`${rowLabel}: paymentTerm '${paymentTermRaw}' not recognized, ignored`)
          }

          const salesmanRaw = str(r.salesman, 100)
          if (salesmanRaw) {
            const id = salesUserByName.get(normalizeName(salesmanRaw))
            if (id) row.salesUserId = id
            else warn(`${rowLabel}: salesman '${salesmanRaw}' not matched to a SALES user, left unset`)
          }

          return row
        },

        async findMatchCandidates(keyValues) {
          if (!keyValues.externalId?.length) return []
          const found = await prisma.customer.findMany({
            where: { externalId: { in: keyValues.externalId as string[] } },
            orderBy: { createdAt: 'asc' },
          })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          const existing = await prisma.customer.findMany({ select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
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
            if (row.paymentTerm !== undefined) updateData.paymentTerm = row.paymentTerm
            if (row.salesUserId !== undefined) updateData.salesUserId = row.salesUserId
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
              paymentTerm: row.paymentTerm ?? 'monthly',
              salesUserId: row.salesUserId ?? null,
              notes: row.notes ?? null,
              updatedBy: user.name || user.email,
            },
          })
          return { id: created.id }
        },

        describeRowError(e, row) {
          const msg = describeContactRowError('customer', isUniqueConstraintError(e), isTransactionTimeoutError(e), row.externalId)
          return msg === 'unknown error' ? lastErrorLine(e) : msg
        },

        auditLog: { userId: user.userId, userEmail: user.email, userName: user.name, resource: 'customer', resourceLabel: '客户' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/customers/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.customer.bulk_import' })
}
