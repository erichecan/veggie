import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, type MatchKeyDef,
} from '@/lib/import/bulk-import-engine'
import { resolveContactCommonFields, describeContactRowError, parseActiveStatus, type ContactCommonFields } from '@/lib/import/contact-fields'
import { parsePaymentTermInput } from '@/lib/payment-terms'

/**
 * POST /api/customers/bulk — 客户批量导入(CSV，20261003 改走全站通用的
 * lib/import/bulk-import-engine.ts，与商品/供应商同款引擎)
 * body: { rows: [{ name*, externalId?, phone?, email?, address?, city?, zip?,
 *   paymentTerm?, salesman?, vatNumber?, notes?, isActive?(Active/Inactive) }], rowOffset? }
 *
 * 新增能力(原来只会创建，撞名就跳过)：按 externalId 精确匹配更新已有客户——
 * 跟商品模块一致的"导出 → Excel 改 → 重新导入"路径。都没传/没匹配上则落回
 * 按名字大小写不敏感判重，撞了跳过(不覆盖)。更新时只覆盖本行提供了非空值的字段。
 */

const MAX_ROWS_PER_REQUEST = 500

function normalizeName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, ' ').replace(/\s*\(/g, '(')
}

interface ResolvedCustomerRow extends ContactCommonFields {
  customerNo?: number
  individualOrCompany?: string
  mobile?: string
  street?: string
  street2?: string
  state?: string
  country?: string
  rowLabel: string
  name: string
  paymentTerm?: string
  salesUserId?: string | null
  isActive?: boolean
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
        { field: 'customerNo', get: r => r.customerNo },
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
          if (r.customerNo !== undefined) {
            const customerNo = Number(r.customerNo)
            if (!Number.isSafeInteger(customerNo) || customerNo <= 0) {
              warn(`${rowLabel}: invalid customer number, skipped`)
              return null
            }
            row.customerNo = customerNo
          }
          const status = parseActiveStatus(r.isActive)
          if (status.invalid) warn(`${rowLabel}: status '${String(r.isActive)}' not recognized (use Active / Inactive), ignored`)
          row.isActive = status.value
          row.mobile = str(r.mobile, 50)
          row.street = str(r.street, 500)
          row.street2 = str(r.street2, 500)
          row.state = str(r.state, 100)
          row.country = str(r.country, 100)
          const contactType = str(r.individualOrCompany, 30)?.toLowerCase()
          if (contactType) {
            const types: Record<string, string> = { individual: 'individual', company: 'company', '个人': 'individual', '公司': 'company' }
            if (types[contactType]) row.individualOrCompany = types[contactType]
            else warn(`${rowLabel}: contact type '${contactType}' not recognized, ignored`)
          }

          // 五档账期都认，代码/中英文名/导出简称都行(以前只认 cash/weekly/monthly 三个代码，
          // 中文导出的「月结」再导回来会被忽略)
          const paymentTermRaw = str(r.paymentTerm, 40)
          if (paymentTermRaw) {
            const term = parsePaymentTermInput(paymentTermRaw)
            if (term) row.paymentTerm = term
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
          const filters = [
            ...(keyValues.customerNo?.length ? [{ customerNo: { in: keyValues.customerNo as number[] } }] : []),
            ...(keyValues.externalId?.length ? [{ externalId: { in: keyValues.externalId as string[] } }] : []),
          ]
          if (!filters.length) return []
          const found = await prisma.customer.findMany({
            where: { OR: filters },
            orderBy: { createdAt: 'asc' },
          })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          const existing = await prisma.customer.findMany({ select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          if (row.customerNo !== undefined && !existingId) {
            throw new Error(`Customer No ${row.customerNo} not found; leave it blank to create a customer`)
          }
          const contactFields = Object.fromEntries(
            ['individualOrCompany', 'mobile', 'street', 'street2', 'state', 'country']
              .filter(key => row[key as keyof ResolvedCustomerRow] !== undefined)
              .map(key => [key, row[key as keyof ResolvedCustomerRow]]),
          )
          if (existingId) {
            const updateData: Record<string, unknown> = { ...contactFields, name: row.name, updatedBy: user.name || user.email }
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
            if (row.isActive !== undefined) updateData.isActive = row.isActive
            if (['street', 'street2', 'city', 'state', 'zip', 'country'].some(key => row[key as keyof ResolvedCustomerRow] !== undefined)) {
              const before = await tx.customer.findUniqueOrThrow({ where: { id: existingId } })
              const merged = { ...before, ...updateData }
              updateData.address = [merged.street, merged.street2, merged.city, merged.state, merged.zip, merged.country].filter(Boolean).join(', ')
            }
            const updated = await tx.customer.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.customer.update>[0]['data'],
            })
            return { id: updated.id }
          }
          const created = await tx.customer.create({
            data: {
              ...contactFields,
              name: row.name,
              externalId: row.externalId ?? null,
              phone: row.phone ?? '',
              email: row.email ?? '',
              address: row.street || row.street2
                ? [row.street, row.street2, row.city, row.state, row.zip, row.country].filter(Boolean).join(', ')
                : row.address ?? '',
              city: row.city ?? null,
              zip: row.zip ?? '',
              vatNumber: row.vatNumber ?? '',
              paymentTerm: row.paymentTerm ?? 'monthly',
              salesUserId: row.salesUserId ?? null,
              isActive: row.isActive ?? true,
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
