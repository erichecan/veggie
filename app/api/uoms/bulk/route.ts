import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, bool, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, normalizeNameKey,
  type MatchKeyDef, importOptionsFromBody,
} from '@/lib/import/bulk-import-engine'

/**
 * POST /api/uoms/bulk — 计量单位批量导入(CSV，20261003 补齐，此前这个模块完全没有
 * 导入导出，只能在 settings 页面手动增删)。
 * body: { rows: [{ name*, nameZh?, category*, goodsType?, expandByCustomer? }], rowOffset? }
 *
 * ⛔ 本次只支持"新建"：Uom 没有像商品/客户那样的业务友好唯一键(externalId 等)，
 * 真正的唯一约束是 (categoryId, name) 这个组合键，本引擎的匹配键机制按单字段设计，
 * 不适合在这里强行拼一个复合匹配 —— 按名字全局判重(不分类别)，撞了就跳过，不更新。
 * 需要改已有单位的货物类型/拣货展开设置，走 settings 页面的单条编辑。
 */

const MAX_ROWS_PER_REQUEST = 500
const GOODS_TYPES = new Set(['BULK', 'LOOSE'])

interface ResolvedRow {
  rowLabel: string
  name: string
  nameZh?: string
  categoryId?: string
  goodsType?: 'BULK' | 'LOOSE'
  expandByCustomer?: boolean
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

      const categories = await prisma.uomCategory.findMany({ select: { id: true, name: true, nameZh: true } })
      const categoryByName = new Map<string, string>()
      for (const c of categories) { categoryByName.set(normalizeNameKey(c.name), c.id); if (c.nameZh) categoryByName.set(normalizeNameKey(c.nameZh), c.id) }

      const matchKeys: MatchKeyDef<ResolvedRow>[] = [] // 无业务友好唯一键，见上方说明

      const result = await runBulkImport<Record<string, unknown>, ResolvedRow>({
        rawRows,
        rowOffset,
        // 试运行 / 导入历史(20261008)：dryRun、importId、fileName、batch 由导入弹窗带上来
        ...importOptionsFromBody(data),
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const row: ResolvedRow = { rowLabel, name }
          row.nameZh = str(r.nameZh, 200)

          const categoryName = str(r.category, 200)
          if (!categoryName) { warn(`${rowLabel}: missing required 'category', skipped`); return null }
          const categoryId = categoryByName.get(normalizeNameKey(categoryName))
          if (!categoryId) { warn(`${rowLabel}: category '${categoryName}' not found, skipped`); return null }
          row.categoryId = categoryId

          const goodsTypeRaw = str(r.goodsType, 20)?.toUpperCase()
          if (goodsTypeRaw) {
            if (GOODS_TYPES.has(goodsTypeRaw)) row.goodsType = goodsTypeRaw as 'BULK' | 'LOOSE'
            else warn(`${rowLabel}: goodsType '${goodsTypeRaw}' not recognized, defaulted to BULK`)
          }

          const expand = bool(r.expandByCustomer)
          if (expand.invalid) warn(`${rowLabel}: expandByCustomer value not recognized, defaulted to N`)
          row.expandByCustomer = expand.value

          return row
        },

        async findMatchCandidates() {
          return [] // 无匹配键，恒落回按名字判重
        },

        async findExistingNames() {
          const existing = await prisma.uom.findMany({ select: { name: true } })
          return new Set(existing.map(u => u.name.toLowerCase()))
        },

        async writeRow(tx, row) {
          const created = await tx.uom.create({
            data: {
              name: row.name,
              nameZh: row.nameZh ?? null,
              categoryId: row.categoryId as string,
              goodsType: row.goodsType ?? 'BULK',
              expandByCustomer: row.expandByCustomer ?? false,
            },
          })
          return { id: created.id }
        },

        describeRowError(e, row) {
          if (isUniqueConstraintError(e)) return `unit '${row.name}' already exists in this category, row not imported`
          if (isTransactionTimeoutError(e)) return 'database timed out, row not imported — please re-import this row'
          return lastErrorLine(e)
        },

        auditLog: { userId: user.userId, userEmail: user.email, userName: user.name, resource: 'uom', resourceLabel: '计量单位' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/uoms/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.uom.create' })
}
