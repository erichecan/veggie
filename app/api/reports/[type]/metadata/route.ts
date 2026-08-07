import { NextResponse } from 'next/server'
import { withAuth, effectiveRoles } from '@/lib/auth'
import { REPORT_REGISTRY } from '@/lib/reports/definitions'
import type { ReportType } from '@/lib/reports/types'

const REPORT_ROLES = ['OPERATOR', 'BOSS', 'FINANCE', 'SALES', 'DRIVER']

const ROLE_REPORT_ACCESS: Record<string, ReportType[]> = {
  OPERATOR: ['sales', 'purchasing', 'logistics'],
  BOSS:     ['sales', 'purchasing', 'logistics'],
  FINANCE:  ['sales', 'purchasing', 'logistics'],
  SALES:    ['sales'],
  DRIVER:   ['logistics'],
}

export async function GET(
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

    return NextResponse.json({
      type: reportType,
      dimensions: Object.values(registry.dimensions),
      measures: Object.values(registry.measures),
    })
  }, { require: 'analytics.report.read' })
}
