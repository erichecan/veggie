import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { parseDsl, validateDslSemantics, fillDefaults } from '@/lib/analytics-chat/dsl-schema'
import { compileAndRun } from '@/lib/analytics-chat/compiler'
import { narrateResult } from '@/lib/analytics-chat/llm'
import { getMetricDef } from '@/lib/analytics/semantic-model'

const DIMENSION_LABELS_ZH: Record<string, string> = {
  product: '商品', category: '分类', customer: '客户', salesUser: '业务员',
  day: '日', week: '周', month: '月',
}

/**
 * POST /api/analytics-chat/confirm
 * ============================================================================
 * 老板确认过确认文案之后才会打这个接口——**真正在生产库上执行只读查询**的
 * 唯一入口。DSL 在这里要重新校验一遍（客户端传回来的东西不可信任，哪怕它
 * 是从 /message 原样传回来的），校验不过直接拒绝，不降级成近似执行。
 *
 * body: { dsl: AnalysisDsl, rawQuestion: string }
 */
export async function POST(req: Request) {
  const denied = rateLimit(req, { id: 'analytics-chat-confirm', max: 20, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    const body = await req.json().catch(() => null)
    const rawQuestion = typeof body?.rawQuestion === 'string' ? body.rawQuestion : ''

    const parsed = parseDsl(body?.dsl)
    if ('message' in parsed) {
      await prisma.analysisQueryLog.create({
        data: { userId: user.userId, rawQuestion, status: 'failed_validation', errorMessage: parsed.message },
      })
      return NextResponse.json({ error: parsed.message }, { status: 400 })
    }
    const semanticError = validateDslSemantics(parsed)
    if (semanticError) {
      await prisma.analysisQueryLog.create({
        data: { userId: user.userId, rawQuestion, status: 'failed_validation', errorMessage: semanticError.message },
      })
      return NextResponse.json({ error: semanticError.message }, { status: 400 })
    }

    const dsl = fillDefaults(parsed)
    const startedAt = Date.now()

    try {
      const result = await compileAndRun(dsl)
      const durationMs = Date.now() - startedAt

      const metricDef = getMetricDef(dsl.metric)
      const narrative = await narrateResult({
        metric: dsl.metric,
        dimensionLabel: dsl.dimension ? (DIMENSION_LABELS_ZH[dsl.dimension] ?? dsl.dimension) : null,
        total: result.total,
        truncated: result.truncated,
        topRows: result.rows.slice(0, 10).map((r) => ({ name: r.name, value: r.value })),
      })

      await prisma.analysisQueryLog.create({
        data: {
          userId: user.userId,
          rawQuestion,
          dsl: dsl as unknown as object,
          confirmedParams: dsl.confirmedParams as unknown as object,
          status: 'confirmed',
          rowCount: result.rows.length,
          durationMs,
        },
      })

      return NextResponse.json(serializeApi({
        dsl,
        metricLabel: metricDef?.labelZh ?? dsl.metric,
        result,
        narrative,
      }))
    } catch (error) {
      console.error('[POST /api/analytics-chat/confirm]', error)
      await prisma.analysisQueryLog.create({
        data: {
          userId: user.userId,
          rawQuestion,
          dsl: dsl as unknown as object,
          status: 'failed_validation',
          errorMessage: '执行查询失败',
        },
      })
      return NextResponse.json({ error: '执行查询失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'analytics.chat.read' })
}
