import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import {
  runBulkImport, str, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, normalizeNameKey,
  type MatchKeyDef, importOptionsFromBody,
} from '@/lib/import/bulk-import-engine'

/**
 * POST /api/product-categories/bulk — 产品分类批量导入(CSV，20261003 补齐，此前
 * 这个模块完全没有导入导出，只能在 settings 页面手动增删)。
 * body: { rows: [{ externalId?, name*, nameZh?, group?, requiredZone? }], rowOffset? }
 *
 * 按 externalId 精确匹配更新已有分类，没传/没匹配上则落回按名字判重(撞了跳过)。
 * group/requiredZone 按名称查找(中英文名均可命中)，查不到就留空(不报错阻断整行)。
 */

const MAX_ROWS_PER_REQUEST = 500

interface ResolvedRow {
  rowLabel: string
  name: string
  externalId?: string
  nameZh?: string
  groupId?: string
  requiredZoneId?: string
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

      const [groups, zones] = await Promise.all([
        prisma.categoryGroup.findMany({ select: { id: true, name: true, nameZh: true } }),
        prisma.zone.findMany({ select: { id: true, name: true, nameZh: true } }),
      ])
      const groupByName = new Map<string, string>()
      for (const g of groups) { groupByName.set(normalizeNameKey(g.name), g.id); if (g.nameZh) groupByName.set(normalizeNameKey(g.nameZh), g.id) }
      const zoneByName = new Map<string, string>()
      for (const z of zones) { zoneByName.set(normalizeNameKey(z.name), z.id); if (z.nameZh) zoneByName.set(normalizeNameKey(z.nameZh), z.id) }

      const matchKeys: MatchKeyDef<ResolvedRow>[] = [
        { field: 'externalId', get: r => r.externalId },
      ]

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
          row.externalId = str(r.externalId, 100)
          row.nameZh = str(r.nameZh, 200)

          const groupName = str(r.group, 200)
          if (groupName) {
            const id = groupByName.get(normalizeNameKey(groupName))
            if (id) row.groupId = id
            else warn(`${rowLabel}: group '${groupName}' not found, left unset`)
          }
          const zoneName = str(r.requiredZone, 200)
          if (zoneName) {
            const id = zoneByName.get(normalizeNameKey(zoneName))
            if (id) row.requiredZoneId = id
            else warn(`${rowLabel}: requiredZone '${zoneName}' not found, left unset`)
          }
          return row
        },

        async findMatchCandidates(keyValues) {
          if (!keyValues.externalId?.length) return []
          const found = await prisma.productCategory.findMany({
            where: { externalId: { in: keyValues.externalId as string[] } },
            orderBy: { id: 'asc' },
          })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          const existing = await prisma.productCategory.findMany({ select: { name: true } })
          return new Set(existing.map(c => c.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          if (existingId) {
            const updateData: Record<string, unknown> = { name: row.name }
            if (row.externalId !== undefined) updateData.externalId = row.externalId
            if (row.nameZh !== undefined) updateData.nameZh = row.nameZh
            if (row.groupId !== undefined) updateData.groupId = row.groupId
            if (row.requiredZoneId !== undefined) updateData.requiredZoneId = row.requiredZoneId
            const updated = await tx.productCategory.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.productCategory.update>[0]['data'],
            })
            return { id: updated.id }
          }
          const created = await tx.productCategory.create({
            data: {
              name: row.name,
              externalId: row.externalId ?? null,
              nameZh: row.nameZh ?? null,
              groupId: row.groupId ?? null,
              requiredZoneId: row.requiredZoneId ?? null,
            },
          })
          return { id: created.id }
        },

        describeRowError(e, row) {
          if (isUniqueConstraintError(e)) {
            return row.externalId
              ? `ID '${row.externalId}' is already used by another category, row not imported`
              : 'a unique field is already used by another category, row not imported'
          }
          if (isTransactionTimeoutError(e)) return 'database timed out, row not imported — please re-import this row'
          return lastErrorLine(e)
        },

        auditLog: { userId: user.userId, userEmail: user.email, userName: user.name, resource: 'product_category', resourceLabel: '产品分类' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/product-categories/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  // 这个端点能新建也能按 externalId 更新已有分类，权限点必须用 update(与 products/bulk
  // 用 master.product.update 同一个道理)——只给 create 的话，一个只被授予「新建分类」
  // 权限、没给「改分类」权限的角色，能靠构造带 ID 的 CSV 绕过 update 权限改掉已有分类。
  }, { require: 'master.product_category.update' })
}
