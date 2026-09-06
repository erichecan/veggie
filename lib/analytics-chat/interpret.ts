/**
 * AI 问数 · 理解编排（20260906）
 * ============================================================================
 * 把"问 Gemini → 格式校验 → 业务语义校验"这条链路串起来，校验不过就把错误
 * 原文喂回 Gemini 自我纠正，最多重试 2 次；仍不行就诚实告诉用户"理解不了"，
 * 不降级成执行一个凑合的近似查询。
 *
 * `fetchInterpretation` 参数默认是真实的 `interpretQuestion`（调 Gemini），
 * 单测传一个假实现进来，不用碰网络就能测完整个重试状态机。
 */
import { interpretQuestion } from './llm'
import { parseDsl, validateDslSemantics, fillDefaults, type AnalysisDsl } from './dsl-schema'

export type InterpretResult =
  | { status: 'confirm'; dsl: AnalysisDsl }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; reason: string }

const MAX_RETRIES = 2

export async function interpretToDsl(
  question: string,
  priorDsl: AnalysisDsl | null = null,
  fetchInterpretation: typeof interpretQuestion = interpretQuestion,
): Promise<InterpretResult> {
  let hint: string | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const outcome = await fetchInterpretation(question, priorDsl, hint)

    if ('unavailable' in outcome) return { status: 'error', reason: outcome.reason }
    if ('failed' in outcome) {
      hint = outcome.reason
      continue
    }

    const raw = outcome.raw as { understood?: unknown; unsupportedReason?: unknown; dsl?: unknown }
    if (raw.understood === false) {
      return {
        status: 'unsupported',
        reason: typeof raw.unsupportedReason === 'string' && raw.unsupportedReason
          ? raw.unsupportedReason
          : '这个问题暂不支持',
      }
    }

    const parsed = parseDsl(raw.dsl)
    if ('message' in parsed) {
      hint = parsed.message
      continue
    }
    const semanticError = validateDslSemantics(parsed)
    if (semanticError) {
      hint = semanticError.message
      continue
    }
    return { status: 'confirm', dsl: fillDefaults(parsed) }
  }

  return { status: 'error', reason: '多次尝试仍无法理解这个问题，换个说法试试？' }
}
