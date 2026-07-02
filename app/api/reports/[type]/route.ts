import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth, effectiveRoles, type JwtPayload } from '@/lib/auth'
import { REPORT_REGISTRY } from '@/lib/reports/definitions'
import { buildReportSQL } from '@/lib/reports/sql-builder'
import type { ReportRequest, ReportResponse, ReportType } from '@/lib/reports/types'

const REPORT_ROLES = ['OPERATOR', 'BOSS', 'FINANCE', 'SALES', 'DRIVER']

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
      console.error('[Reports API]', err)
      const message = err instanceof Error ? err.message : '报表查询失败'
      return NextResponse.json({ error: message }, { status: 500 })
    }
  }, REPORT_ROLES)
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
