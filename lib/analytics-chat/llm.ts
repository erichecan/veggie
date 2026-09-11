/**
 * AI 问数 · Gemini 交互层（20260906，20260910 扩成跨域 + 明细模式，20260911 加歧义消歧）
 * ============================================================================
 * 调用范式沿用 `lib/purchase/ai-pdf-parser.ts`（`@google/genai`、JSON mode +
 * `responseSchema` 强约束输出、同一档模型）。三个用途：
 *   1. `interpretQuestion`：自然语言 → DSL 草稿。responseSchema 里 metric/
 *      dimension 用的是**全部四个 domain 合并后的枚举**（Gemini 的 schema 不
 *      支持"选了 domain=X 之后 metric 枚举收窄成 X 的"这种条件依赖），真正
 *      "这个 metric 是不是这个 domain 的"由 dsl-schema.ts 兜底校验，校验不过
 *      走 interpret.ts 的重试机制把错误原因喂回去让模型自己修正。
 *   2. `checkAlternativeDomain`：歧义探测，独立的小 schema 调用（见下方
 *      "为什么歧义检测要拆成单独一次调用" 说明）。
 *   3. `narrateResult`：聚合后的小结果 → 自然语言解读（只对 aggregate 模式；
 *      detail 模式直接给明细表格，不需要 AI 复述一遍）
 * `filters` 字段刻意不放进 responseSchema——客户名/商品名到 id 的解析 v1 没做，
 * 给了字段只会诱使模型自己编一个 id。
 *
 * ⛔ 为什么歧义检测要拆成单独一次调用，不直接在 DSL_RESPONSE_SCHEMA 里加
 * `ambiguous`+`alternativeDsl` 两个字段：
 * 20260911 实测过，一旦加了这两个字段（哪怕只是加字段、prompt 反复强调"其它字段照常填"），
 * `gemini-3.1-flash-lite`（本项目能用的最轻量档）在"7月3号客户订单，每家都送什么货，
 * 单价数量"这类问题上会稳定地（4/4 次复现）丢掉 dateRange 甚至整个 alternativeDsl，
 * 哪怕这句话单独问（不带歧义字段的旧 schema）时抽取 dateRange 100% 稳定。schema 一复杂，
 * 这档模型的结构化输出质量就会滑坡。所以歧义检测必须是一次独立的、schema 极简的调用，
 * 不能和主 DSL 抽取合并，主 DSL 抽取的 schema/prompt 保持 20260910 验证过的原样不动。
 */
import { GoogleGenAI, Type } from '@google/genai'
import { toDayKey } from '@/lib/analytics/metrics'
import { DOMAIN_DEFS, isDomainKey, type DomainKey, type MetricDef } from './domains'
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

const ALL_METRIC_KEYS = Object.values(DOMAIN_DEFS).flatMap((d) => Object.keys(d.metrics))
const ALL_DIMENSION_KEYS = Array.from(new Set(Object.values(DOMAIN_DEFS).flatMap((d) => Object.keys(d.dimensions))))
const DOMAIN_KEYS = Object.keys(DOMAIN_DEFS)

function metricLine(m: MetricDef): string {
  const params = Object.entries(m.confirmableParams)
    .map(([k, def]) => def && `${k}（${def.labelZh}，可选：${def.options.map((o) => `${o}=${def.optionLabelsZh[o]}`).join('/')}，默认 ${def.default}）`)
    .filter(Boolean)
    .join('；')
  return `  - ${m.key}（${m.labelZh}）：${params || '无可选参数，口径固定'}`
}

function domainCatalogText(): string {
  return Object.values(DOMAIN_DEFS).map((d) => {
    const metrics = Object.values(d.metrics).map(metricLine).join('\n')
    const dims = Object.keys(d.dimensions).map((k) => `${k}=${d.dimensionLabelsZh[k] ?? k}`).join('、')
    const detailNote = d.detail ? `本域支持"明细"模式（mode=detail）：直接列出逐行原始数据（如商品/单价/数量），不做汇总，此时不填 metric/dimension` : '本域不支持明细模式'
    return `【${d.key}（${d.labelZh}）】\n指标：\n${metrics}\n可分组维度：${dims}\n${detailNote}`
  }).join('\n\n')
}

const DSL_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    understood: {
      type: Type.BOOLEAN,
      description: '这句话是否能映射到下面列出的指标体系；映射不到（比如问了不存在的域/维度/指标）就给 false',
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
        domain: { type: Type.STRING, enum: DOMAIN_KEYS, description: '这句话问的是哪个业务域' },
        mode: {
          type: Type.STRING,
          nullable: true,
          enum: ['aggregate', 'detail'],
          description: '问的是汇总数字给 aggregate（默认）；问的是逐行明细/清单（如"每家送了什么/单价/数量"）给 detail',
        },
        metric: {
          type: Type.STRING,
          nullable: true,
          enum: ALL_METRIC_KEYS,
          description: 'mode=aggregate 时必填，且必须是所选 domain 下真正存在的指标；mode=detail 时给 null',
        },
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
          enum: ALL_DIMENSION_KEYS,
          description: '按哪个维度分组；问题里没提到"按 XX 看/分"这类分组意图，或 mode=detail，就给 null',
        },
        dateRange: {
          type: Type.OBJECT,
          nullable: true,
          properties: {
            from: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD，问题没给出明确/可推算的日期范围就给 null（mode=detail 时必须给出，问题没说清楚就把 understood 设 false 并说明原因）' },
            to: { type: Type.STRING, nullable: true, description: 'YYYY-MM-DD' },
          },
        },
      },
      required: ['domain'],
    },
  },
  required: ['understood'],
} as const

function buildInterpretPrompt(question: string, priorDsl: AnalysisDsl | null, retryHint: string | null, forcedDomain: DomainKey | null): string {
  const today = toDayKey(new Date())
  const priorContext = priorDsl
    ? `\n上一轮已经理解出的查询（如果这句话是对上一轮的追问/修改，比如"那按客户再看一下"，请在这份基础上只改动被要求改动的部分，其余原样保留）：\n${JSON.stringify(priorDsl)}\n`
    : ''
  const retryContext = retryHint
    ? `\n⚠️ 你上一次的回答有问题，原因：${retryHint}——请修正后重新给出，不要重复同样的错误。\n`
    : ''
  const forcedDomainContext = forcedDomain
    ? `\n⚠️ 这次不用你自己判断业务域——把 domain 固定为 "${forcedDomain}"，按这个域重新理解这句话，其它字段（mode/metric/dimension/dateRange）仍要正常按问题内容填好。\n`
    : ''
  return `你是一个数据分析问题理解助手。今天是 ${today}（欧洲/都柏林时区），把老板的自然语言问题翻译成一份结构化查询——你**只产出结构化参数，不产出任何 SQL 或代码**。

系统按四个业务域组织数据，每个域各自的指标/维度如下（没列出来的规则，比如统计哪些订单状态、按哪个日期字段，都是系统写死的，不接受任何变体，也不要在 dsl 里编造）：

${domainCatalogText()}

如果问题问的域/指标/维度不在上面这份清单里（比如问"库存周转率"这种系统没有的东西），把 understood 设成 false，unsupportedReason 用一句话说明，dsl 给 null——不要凑一个近似的指标或维度顶上去。
${forcedDomainContext}${priorContext}${retryContext}
老板的问题：「${question}」`
}

export async function interpretQuestion(
  question: string,
  priorDsl: AnalysisDsl | null = null,
  retryHint: string | null = null,
  forcedDomain: DomainKey | null = null,
): Promise<InterpretOutcome> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { unavailable: true, reason: '未配置 GEMINI_API_KEY，AI 问数不可用' }

  const ai = new GoogleGenAI({ apiKey })
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: buildInterpretPrompt(question, priorDsl, retryHint, forcedDomain) }] }],
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

const AMBIGUITY_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    alternativeDomain: {
      type: Type.STRING,
      nullable: true,
      enum: DOMAIN_KEYS,
      description: '如果这句话除了已选中的域，换一个域理解也同样说得通，给出那个域的 key；只有一种域说得通就给 null，不要为了显得谨慎而滥用',
    },
  },
  required: [],
} as const

const DOMAIN_ONE_LINERS = Object.values(DOMAIN_DEFS)
  .map((d) => `- ${d.key}（${d.labelZh}）`)
  .join('\n')

/**
 * 独立的歧义探测调用：schema 极简（只有一个可空字符串字段），不带 dateRange/metric 这些
 * 容易被"顺带问"拖垮质量的复杂字段。只在 interpret.ts 拿到主候选之后调用一次。
 */
export async function checkAlternativeDomain(
  question: string,
  primaryDomain: DomainKey,
): Promise<InterpretOutcome> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return { unavailable: true, reason: '未配置 GEMINI_API_KEY，AI 问数不可用' }

  const prompt = `业务系统按下面几个域组织数据：
${DOMAIN_ONE_LINERS}

已经把这句话理解成"${primaryDomain}"域的问题。除了这个域，这句话换一个域理解是否也同样合理？
比如"客户订单送了什么货"，既可能是问 sales 域记的订单本身，也可能是问 delivery 域实际配送执行——
这种情况给出那个域的 key；如果只有当前这一种域说得通，给 null。

问题：「${question}」`

  const ai = new GoogleGenAI({ apiKey })
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      config: { responseMimeType: 'application/json', responseSchema: AMBIGUITY_SCHEMA },
    })
    const text = response.text
    if (!text) return { failed: true, reason: 'AI 未返回可解析内容' }
    return { raw: JSON.parse(text) }
  } catch (err) {
    console.error('[checkAlternativeDomain] generateContent failed', err)
    return { failed: true, reason: 'AI 歧义探测调用失败' }
  }
}

/** 从 checkAlternativeDomain 的 raw 输出里取出一个合法且与 primaryDomain 不同的候选域，取不到就 null */
export function parseAlternativeDomain(outcome: InterpretOutcome, primaryDomain: DomainKey): DomainKey | null {
  if (!('raw' in outcome)) return null
  const raw = outcome.raw as { alternativeDomain?: unknown }
  const candidate = raw.alternativeDomain
  if (!isDomainKey(candidate) || candidate === primaryDomain) return null
  return candidate
}

export interface NarrateInput {
  domain: string
  metric: string
  dimensionLabel: string | null
  total: number
  truncated: boolean
  topRows: Array<{ name: string; value: number }>
}

/** 结果解读失败不影响主流程——降级成不给解读文字，前端只显示数字，不是整条链路失败。仅 aggregate 模式调用 */
export async function narrateResult(input: NarrateInput): Promise<string | null> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) return null

  const domainDef = DOMAIN_DEFS[input.domain as keyof typeof DOMAIN_DEFS]
  const metricLabel = domainDef?.metrics[input.metric]?.labelZh ?? input.metric
  const prompt = `你在给老板做一份数据分析结果的口头汇报，只看得到下面这些已经算好的聚合数字，看不到任何原始订单明细，不要编造任何数字之外的信息。

指标：${metricLabel}
${input.dimensionLabel ? `分组维度：${input.dimensionLabel}` : '未分组（总计）'}
合计：${input.total}
${input.truncated ? `（分组结果超过 ${500} 行，只取了排名前 500）` : ''}
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
