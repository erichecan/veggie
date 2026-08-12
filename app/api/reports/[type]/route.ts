import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, effectiveRoles, type JwtPayload } from '@/lib/auth'
import { REPORT_REGISTRY } from '@/lib/reports/definitions'
import { buildReportSQL, ReportRequestError } from '@/lib/reports/sql-builder'
import type { ReportRequest, ReportResponse, ReportType } from '@/lib/reports/types'

const REPORT_ROLES = ['OPERATOR', 'BOSS', 'FINANCE', 'SALES', 'DRIVER']

/**
 * 报表类型的角色可见性。
 *
 * ⚠️ **SALES / DRIVER 这两行当前够不着**（台账 H2 实测）：本路由在 gate 层要求
 * `analytics.report.generate`，而 `sales` 与 `driver` 两个角色一个 analytics.* 权限都没有，
 * 请求在进到这里之前就已经 403。于是这两行是**装饰性配置** —— 看着像"业务员能看销售报表"，
 * 实际谁也看不到。（同类问题 I2 查出过 13 个装饰性权限点。）
 *
 * 刻意**不在本轮擅自给它们补权限**：那等于扩大数据可见面，是产品决策不是实现细节。
 * 要么补权限让这两行生效，要么删掉这两行，见台账「待决策 13」。
 * 在决定之前，这段注释就是防止下一个人对着这张表得出错误结论的唯一屏障。
 */
const ROLE_REPORT_ACCESS: Record<string, ReportType[]> = {
  OPERATOR: ['sales', 'purchasing', 'logistics'],
  BOSS:     ['sales', 'purchasing', 'logistics'],
  FINANCE:  ['sales', 'purchasing', 'logistics'],
  SALES:    ['sales'],
  DRIVER:   ['logistics'],
}

export async function POST(
  request: Request,
  { params }: { params: Promise<{ type: string }> },
) {
  return withAuth(request, async (user) => {
    const { type } = await params
    const reportType = type as ReportType
    const registry = REPORT_REGISTRY[reportType]
    if (!registry) {
      return NextResponse.json({ error: `无效报表类型: ${type}` }, { status: 400 })
    }

    const roles = effectiveRoles(user)
    const accessible = roles.flatMap(r => ROLE_REPORT_ACCESS[r] ?? [])
    if (!accessible.includes(reportType)) {
      return NextResponse.json({ error: '无权访问此报表' }, { status: 403 })
    }

    let body: ReportRequest
    try {
      body = await request.json()
    } catch {
      return NextResponse.json({ error: '请求体必须是有效 JSON' }, { status: 400 })
    }

    if (!body.rowDimensions?.length && !body.colDimensions?.length) {
      return NextResponse.json({ error: '至少需要一个分组维度' }, { status: 400 })
    }
    if (!body.measures?.length) {
      return NextResponse.json({ error: '至少需要一个度量' }, { status: 400 })
    }

    applyRoleFilters(user, roles, reportType, body)

    try {
      const { sql, params: sqlParams, countSql, totalsSql } = buildReportSQL(
        registry.view,
        body,
        registry.dimensions,
        registry.measures,
      )

      const [rows, countResult, totalsResult] = await Promise.all([
        prisma.$queryRawUnsafe(sql, ...sqlParams) as Promise<Record<string, unknown>[]>,
        prisma.$queryRawUnsafe(countSql, ...sqlParams) as Promise<{ total: bigint }[]>,
        prisma.$queryRawUnsafe(totalsSql, ...sqlParams) as Promise<Record<string, unknown>[]>,
      ])

      const total = Number(countResult[0]?.total ?? 0)
      const totals = serializeRow(totalsResult[0] ?? {})

      const response: ReportResponse = {
        rows: rows.map(serializeRow),
        totals: totals as Record<string, number>,
        total,
        limit: Math.min(body.limit ?? 200, 10000),
        offset: body.offset ?? 0,
      }

      return NextResponse.json(response)
    } catch (err) {
      // 输入不合法是 400，不是 500。原先一律 500 —— 用户选错维度看到「服务器错误」，
      // 而真正的库故障混在一堆正常校验里，日志失去筛选价值（台账 H2）
      if (err instanceof ReportRequestError) {
        return NextResponse.json({ error: err.message }, { status: 400 })
      }
      console.error('[Reports API]', err)
      const message = err instanceof Error ? err.message : '报表查询失败'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }, { require: 'analytics.report.generate' })
}

function applyRoleFilters(
  user: JwtPayload,
  roles: string[],
  reportType: ReportType,
  body: ReportRequest,
) {
  if (roles.includes('OPERATOR') || roles.includes('BOSS') || roles.includes('FINANCE')) {
    return
  }

  if (!body.filters) body.filters = []

  if (roles.includes('SALES') && reportType === 'sales') {
    body.filters.push({ field: 'sales_user_id', operator: '=', value: user.userId })
  }
  if (roles.includes('DRIVER') && reportType === 'logistics') {
    body.filters.push({ field: 'driver_name', operator: '=', value: user.name })
  }
}

function serializeRow(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(row)) {
    if (typeof v === 'bigint') {
      out[k] = Number(v)
    } else if (v instanceof Date) {
      out[k] = v.toISOString()
    } else {
      out[k] = v
    }
  }
  return out
}
