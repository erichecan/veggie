/**
 * AI 问数 · Gemini 交互层（20260906）
 * ============================================================================
 * 调用范式沿用 `lib/purchase/ai-pdf-parser.ts`（`@google/genai`、JSON mode +
 * `responseSchema` 强约束输出、同一档模型）。两个用途：
 *   1. `interpretQuestion`：自然语言 → DSL 草稿（只产出结构化 JSON，不产出
 *      SQL/代码；`filters` 字段刻意不放进 responseSchema——客户名/商品名到
 *      id 的解析 v1 没做，给了字段只会诱使模型自己编一个 id 出来）
 *   2. `narrateResult`：聚合后的小结果 → 自然语言解读（这一步模型只看得到
 *      聚合数字，不接触任何明细行）
 * 两个函数都不做校验，校验是 `dsl-schema.ts` 的职责——这里只负责"问模型"。
 */
import { GoogleGenAI, Type } from '@google/genai'
import { toDayKey } from '@/lib/analytics/metrics'
import { METRIC_DEFS, CHAT_DIMENSION_KEYS, type MetricKey } from '@/lib/analytics/semantic-model'
import type { AnalysisDsl } from './dsl-schema'

// 与 ai-pdf-parser.ts 同一档：gemini-2.5/3.6 在这个 API 项目上全系 404，
// 3.1-flash-lite 是探测下来最轻量、免费额度内稳定可用的一档。
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'

export interface InterpretUnavailable {
  unavailable: true
  reason: string
}

export interface InterpretFailure {
  failed: true
  reason: string
}

export type InterpretOutcome =
  | { raw: unknown }
  | InterpretUnavailable
  | InterpretFailure

const DIMENSION_LABELS_ZH: Record<string, string> = {
  product: '商品', category: '分类', customer: '客户', salesUser: '业务员',
  day: '日', week: '周', month: '月',
}

function metricCatalogText(): string {
  return Object.values(METRIC_DEFS).map((m) => {
    const params = Object.entries(m.confirmableParams)
      .map(([k, def]) => def && `${k}（${def.labelZh}，可选：${def.options.map((o) => `${o}=${def.optionLabelsZh[o]}`).join('/')}，默认 ${def.default}）`)
      .filter(Boolean)
      .join('；')
    return `- ${m.key}（${m.labelZh}）：${params || '无可选参数，口径固定'}`
  }).join('\n')
}

const DSL_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    understood: {
      type: Type.BOOLEAN,
      description: '这句话是否能映射到下面列出的指标体系；映射不到（比如问了不存在的维度/指标）就给 false',
    },
    unsupportedReason: {
      type: Type.STRING,
      nullable: true,
      description: 'understood=false 时，用一句人话说明为什么支持不了；understood=true 时给 null',
    },
    dsl: {
      type: Type.OBJECT,
      nullable: true,
      description: 'understood=true 时必须给出；understood=false 时给 null',
      properties: {
        metric: { type: Type.STRING, enum: Object.keys(METRIC_DEFS) },
        confirmedParams: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            taxBasis: { type: Type.STRING, nullable: true, enum: ['preTax', 'incTax'] },
          },
        },
        dimension: {
          type: Type.STRING,
          nullable: true,
          enum: CHAT_DIMENSION_KEYS,
          description: '按哪个维度分组；问题里没提到"按 XX 看/分"这类分组意图就给 null（只要一个总计）',
        },
        dateRange: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            from: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD，问题没给出明确/可推算的日期范围就给 null' },
            to: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD' },
          },
        },
      },
      required: ['metric'],
    },
  },
  required: ['understood'],
} as const

function buildInterpretPrompt(question: string, priorDsl: AnalysisDsl | null, retryHint: string | null): string {
  const today = toDayKey(new Date())
  const priorContext = priorDsl
    ? `\n上一轮已经理解出的查询（如果这句话是对上一轮的追问/修改，比如"那按客户再看一下"，请在这份基础上只改动被要求改动的部分，其余原样保留）：\n${JSON.stringify(priorDsl)}\n`
    : ''
  const retryContext = retryHint
    ? `\n⚠️ 你上一次的回答有问题，原因：${retryHint}——请修正后重新给出，不要重复同样的错误。\n`
    : ''
  return `你是一个数据分析问题理解助手。今天是 ${today}（欧洲/都柏林时区），把老板的自然语言问题翻译成一份结构化查询——你**只产出结构化参数，不产出任何 SQL 或代码**。

系统当前只支持下面这些指标，每个指标的可选参数（这些是真正允许客户选的业务口径；没列出来的规则，比如统计哪些订单状态、按哪个日期字段，都是系统写死的，不接受任何变体，也不要在 dsl 里编造）：
${metricCatalogText()}

可以按下面这些维度分组（同一份 dimension 枚举，中文对照仅供你理解问题，dsl.dimension 必须原样用英文 key）：
${CHAT_DIMENSION_KEYS.map((k) => `${k}=${DIMENSION_LABELS_ZH[k] ?? k}`).join('、')}

如果问题问的指标/维度不在上面这两份清单里（比如问"按邮编分组"、"库存周转率"这种系统没有的东西），把 understood 设成 false，unsupportedReason 用一句话说明，dsl 给 null——不要凑一个近似的指标或维度顶上去。
${priorContext}${retryContext}
老板的问题：「${question}」`
}

export async function interpretQuestion(
  question: string,
  priorDsl: AnalysisDsl | null = null,
  retryHint: string | null = null,
): Promise<InterpretOutcome> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { unavailable: true, reason: '未配置 GEMINI_API_KEY，AI 问数不可用' }

  const ai = new GoogleGenAI({ apiKey })
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: buildInterpretPrompt(question, priorDsl, retryHint) }] }],
      config: { responseMimeType: 'application/json', responseSchema: DSL_RESPONSE_SCHEMA },
    })
    const text = response.text
    if (!text) return { failed: true, reason: 'AI 未返回可解析内容' }
    return { raw: JSON.parse(text) }
  } catch (err) {
    console.error('[interpretQuestion] generateContent failed', err)
    return { failed: true, reason: 'AI 理解调用失败，请稍后重试' }
  }
}

export interface NarrateInput {
  metric: MetricKey
  dimensionLabel: string | null
  total: number
  truncated: boolean
  topRows: Array<{ name: string; value: number }>
}

/** 结果解读失败不影响主流程——降级成不给解读文字，前端只显示数字，不是整条链路失败 */
export async function narrateResult(input: NarrateInput): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const metricLabel = METRIC_DEFS[input.metric]?.labelZh ?? input.metric
  const prompt = `你在给老板做一份数据分析结果的口头汇报，只看得到下面这些已经算好的聚合数字，看不到任何原始订单明细，不要编造任何数字之外的信息。

指标：${metricLabel}
${input.dimensionLabel ? `分组维度：${input.dimensionLabel}` : '未分组（总计）'}
合计：${input.total}
${input.truncated ? '（分组结果超过 500 行，只取了排名前 500）' : ''}
排名前几的分组：${input.topRows.map((r) => `${r.name}: ${r.value}`).join('；') || '无'}

用 2-3 句中文口语化总结这份数据，不要罗列表格，不要用 markdown。`

  const ai = new GoogleGenAI({ apiKey })
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
    })
    return response.text?.trim() || null
  } catch (err) {
    console.error('[narrateResult] generateContent failed', err)
    return null
  }
}
