import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { parseDsl, validateDslSemantics, fillDefaults } from '@/lib/analytics-chat/dsl-schema'

/**
 * GET /api/analytics-chat/reports — 当前用户保存的常用报表列表
 * POST /api/analytics-chat/reports — 把一次已确认的问答存成常用报表（老板主动确认才存，不自动挖掘）
 * ============================================================================
 * 只承接"老板主动确认存下来"这一条路径；要不要从 AnalysisQueryLog 里挖掘
 * 重复问题主动建议入库，是后续迭代的事（见 DEV-PLAN.md 学习/固化那节）。
 */
export async function GET(req: Request) {
  return withAuth(req, async (user) => {
    const reports = await prisma.savedAnalysisReport.findMany({
      where: { userId: user.userId },
      orderBy: { lastUsedAt: 'desc' },
    })
    return NextResponse.json(serializeApi(reports))
  }, { require: 'analytics.chat.read' })
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    const body = await req.json().catch(() => null)
    const name = typeof body?.name === 'string' ? body.name.trim() : ''
    if (!name) return NextResponse.json({ error: '报表名称不能为空' }, { status: 400 })

    const parsed = parseDsl(body?.dsl)
    if ('message' in parsed) return NextResponse.json({ error: parsed.message }, { status: 400 })
    const semanticError = validateDslSemantics(parsed)
    if (semanticError) return NextResponse.json({ error: semanticError.message }, { status: 400 })
    const dsl = fillDefaults(parsed)

    const report = await prisma.savedAnalysisReport.upsert({
      where: { userId_name: { userId: user.userId, name } },
      update: { dsl: dsl as unknown as object },
      create: { userId: user.userId, name, dsl: dsl as unknown as object },
    })
    return NextResponse.json(serializeApi(report))
  }, { require: 'analytics.chat.manage' })
}
