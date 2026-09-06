import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { prisma } from '@/lib/db'
import { serializeApi } from '@/lib/api-serializer'
import { interpretToDsl } from '@/lib/analytics-chat/interpret'
import { renderConfirmationText } from '@/lib/analytics-chat/confirm-template'
import { parseDsl, type AnalysisDsl } from '@/lib/analytics-chat/dsl-schema'

/**
 * POST /api/analytics-chat/message
 * ============================================================================
 * 自然语言问题 → 结构化 DSL 草稿 → 确认文案。**不执行任何查询，不落库**——
 * 只有 /confirm 才会真的跑到生产库上。理解失败/问题不支持都记一条日志，
 * 方便后续复盘"老板问过哪些系统答不上来的问题"。
 *
 * body: { question: string, priorDsl?: AnalysisDsl | null }
 *   priorDsl 用于多轮追问（"那按客户再看一下"）——把上一轮已确认理解的 DSL
 *   带回来，让 LLM 在这份基础上做增量修改，而不是把这句话当全新问题重新猜。
 */
export async function POST(req: Request) {
  const denied = rateLimit(req, { id: 'analytics-chat-message', max: 20, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    try {
      const body = await req.json().catch(() => null)
      const question = typeof body?.question === 'string' ? body.question.trim() : ''
      if (!question) return NextResponse.json({ error: '问题不能为空' }, { status: 400 })

      let priorDsl: AnalysisDsl | null = null
      if (body?.priorDsl) {
        const parsed = parseDsl(body.priorDsl)
        if (!('message' in parsed)) priorDsl = parsed
      }

      const result = await interpretToDsl(question, priorDsl)

      // 理解成功只是"这句话能翻成一份合法查询"，还没执行——真正落审计日志
      // 是在 /confirm 老板点头之后。这里只记"没理解成功"的情况，方便复盘
      // "老板问过哪些系统答不上来的问题"，不会把每一次半途而废的草稿都存下来。
      if (result.status === 'confirm') {
        return NextResponse.json(serializeApi({
          status: 'confirm',
          dsl: result.dsl,
          confirmationText: renderConfirmationText(result.dsl),
        }))
      }

      await prisma.analysisQueryLog.create({
        data: {
          userId: user.userId,
          rawQuestion: question,
          status: result.status === 'unsupported' ? 'unsupported' : 'failed_validation',
          errorMessage: result.reason,
        },
      })
      return NextResponse.json(serializeApi({ status: result.status, reason: result.reason }))
    } catch (error) {
      console.error('[POST /api/analytics-chat/message]', error)
      return NextResponse.json({ error: 'AI 问数理解失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'analytics.chat.read' })
}
