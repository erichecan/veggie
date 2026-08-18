/**
 * GET /api/export/<entity>?<列表页原样的筛选参数>
 * ============================================================================
 * 全站列表页导出的统一入口。吃的参数与列表 API 完全相同 —— 每个实体的
 * load() 复用列表那份 where 构造（见 lib/export/registry.ts），
 * 所以导出的内容就是屏幕上筛出来的内容，不是"另一次查询碰巧也差不多"。
 *
 * 权限：沿用该实体列表的查看权限（lib/export/entities.ts），
 *       middleware 与本路由各判一次，两处读同一张表。
 *
 * 行数上限：超过上限时截断，并在 X-Export-Truncated 头里带上实际匹配总数，
 *          前端据此提示用户"结果超过 N 行，已导出前 M 行"，不静默给半份数据。
 */
import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { buildCsv, csvResponseHeaders } from '@/lib/export/csv'
import { exportEntityMeta } from '@/lib/export/entities'
import { EXPORT_REGISTRY, DEFAULT_EXPORT_ROW_LIMIT, resolveColumns } from '@/lib/export/registry'
import { exportHeaders, exportRows } from '@/lib/export/types'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: Request, { params }: { params: Promise<{ entity: string }> }) {
  const { entity } = await params
  const meta = exportEntityMeta(entity)
  const def = EXPORT_REGISTRY[entity]
  if (!meta || !def) {
    return NextResponse.json({ error: `不支持导出该实体: ${entity}` }, { status: 404 })
  }

  return withAuth(req, async (user) => {
    try {
      const { searchParams } = new URL(req.url)
      const isEn = searchParams.get('locale') === 'en'
      const limit = def.rowLimit ?? DEFAULT_EXPORT_ROW_LIMIT

      const { rows, total } = await def.load({ searchParams, user, limit, isEn })

      const columns = resolveColumns(def.columns, isEn)
      const csv = buildCsv(exportHeaders(columns, isEn), exportRows(columns, rows))
      const today = new Date().toISOString().slice(0, 10)
      const filename = `${isEn ? meta.labelEn : meta.labelZh}-${today}.csv`

      const res = new NextResponse(csv, { headers: csvResponseHeaders(filename) })
      if (total > rows.length) res.headers.set('X-Export-Truncated', String(total))
      return res
    } catch (error) {
      console.error(`[GET /api/export/${entity}]`, error)
      return NextResponse.json({ error: '导出失败' }, { status: 500 })
    }
  }, { require: meta.permission })
}
