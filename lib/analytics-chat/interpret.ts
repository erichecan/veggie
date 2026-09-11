/**
 * AI 问数 · 理解编排（20260906，20260911 加歧义消歧）
 * ============================================================================
 * 把"问 Gemini → 格式校验 → 业务语义校验"这条链路串起来，校验不过就把错误
 * 原文喂回 Gemini 自我纠正，最多重试 2 次；仍不行就诚实告诉用户"理解不了"，
 * 不降级成执行一个凑合的近似查询。
 *
 * `fetchInterpretation`/`fetchAmbiguity` 参数默认是真实的 Gemini 调用，
 * 单测传假实现进来，不用碰网络就能测完整个状态机。
 *
 * 歧义消歧分三步（见 llm.ts 头部注释解释为什么不能合并成一次调用）：
 *   1. 正常拿到主候选 `primary`（走原有、schema 不变的重试循环）
 *   2. 只有"全新问题"（没有 priorDsl，即不是多轮追问）才做歧义探测——追问场景
 *      已经在上一轮定过调，没必要每次都重新怀疑
 *   3. 探测出一个不同的候选域，就再问一次"以这个域为准"的完整 DSL，两个候选各自
 *      独立校验；第二候选校验不过就丢弃它，退化成只给主候选正常确认
 */
import { interpretQuestion, checkAlternativeDomain, parseAlternativeDomain } from './llm'
import { parseDsl, validateDslSemantics, fillDefaults, type AnalysisDsl } from './dsl-schema'

export type InterpretResult =
  | { status: 'confirm'; dsl: AnalysisDsl }
  | { status: 'ambiguous'; candidates: AnalysisDsl[] }
  | { status: 'unsupported'; reason: string }
  | { status: 'error'; reason: string }

const MAX_RETRIES = 2

/** 校验一个候选 DSL；不合法就返回 null（调用方决定要不要因此重试） */
function tryBuildDsl(raw: unknown): AnalysisDsl | null {
  const parsed = parseDsl(raw)
  if ('message' in parsed) return null
  if (validateDslSemantics(parsed)) return null
  return fillDefaults(parsed)
}

async function resolvePrimary(
  question: string,
  priorDsl: AnalysisDsl | null,
  fetchInterpretation: typeof interpretQuestion,
): Promise<InterpretResult> {
  let hint: string | null = null

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    const outcome = await fetchInterpretation(question, priorDsl, hint, null)

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

export async function interpretToDsl(
  question: string,
  priorDsl: AnalysisDsl | null = null,
  fetchInterpretation: typeof interpretQuestion = interpretQuestion,
  fetchAmbiguity: typeof checkAlternativeDomain = checkAlternativeDomain,
): Promise<InterpretResult> {
  const primaryResult = await resolvePrimary(question, priorDsl, fetchInterpretation)
  if (primaryResult.status !== 'confirm') return primaryResult
  const primary = primaryResult.dsl

  // 追问场景（有 priorDsl）不做歧义探测——上一轮已经定过域，多轮追问默认延续同一个域
  if (priorDsl) return primaryResult

  const ambiguityOutcome = await fetchAmbiguity(question, primary.domain)
  const altDomain = parseAlternativeDomain(ambiguityOutcome, primary.domain)
  if (!altDomain) return primaryResult

  const altOutcome = await fetchInterpretation(question, null, null, altDomain)
  if (!('raw' in altOutcome)) return primaryResult // 探测调用失败不影响主结果，静默退化
  const altRaw = altOutcome.raw as { understood?: unknown; dsl?: unknown }
  if (altRaw.understood === false) return primaryResult
  const alt = tryBuildDsl(altRaw.dsl)
  if (!alt || alt.domain !== altDomain) return primaryResult

  return { status: 'ambiguous', candidates: [primary, alt] }
}
