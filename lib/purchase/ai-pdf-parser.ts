/**
 * 采购 PDF 商品行解析 — AI 辅助路径（20260828 原型，默认关闭）
 * ============================================================================
 * 确定性解析（`pdf-line-parser.ts`）是客户 20260819 拍板的默认路径，此文件
 * 不替换它 —— 只有前端显式传 `engine=ai` 才会走到这里，用于对比效果，
 * 是否转正、是否允许把供应商单据发到第三方云端，等看到效果后再由客户拍板。
 *
 * 直接把原始 PDF 作为多模态输入交给模型（而不是先用 pdf-parse 抽文字层再喂
 * 纯文本）：商品明细在表格里、供应商/客户信息在表头表尾，这层版面结构对模型
 * 判断"这行是商品还是地址"是强信号，纯文字层会把它丢掉。
 */
import { GoogleGenAI, Type } from '@google/genai'
import type { ParsedPdfLine, SupplierCandidate } from './pdf-line-parser'

export interface AiPdfParseResult {
  lines: ParsedPdfLine[]
  currency: string | null
  supplierId: string | null
  supplierName: string | null
  /** 人能读懂的失败原因；解析出行时为 null */
  error: string | null
}

export interface AiPdfParseUnavailable {
  unavailable: true
  reason: string
}

// 20260828 实测：gemini-2.5 全系已对新 API 项目下线（Google 强制），2.5/3.6 均命中
// 免费额度当天打满；3.1-flash-lite 是探测下来最老、最轻量、稳定可用的一档。
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite'

const RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    supplierName: {
      type: Type.STRING,
      nullable: true,
      description: '单据上的供应商/卖方公司名（不是收货方/买方抬头）；识别不到给 null',
    },
    currency: {
      type: Type.STRING,
      nullable: true,
      description: 'ISO 4217 三位币种代码，如 EUR/USD/GBP；识别不到给 null',
    },
    lines: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          productName: { type: Type.STRING, description: '商品名称原文，不要翻译，不要带行号/货号前缀' },
          quantity: { type: Type.NUMBER, nullable: true },
          unitCost: {
            type: Type.NUMBER,
            nullable: true,
            description: '单价，不是行小计——同一行如果同时印了单价和小计，取单价',
          },
          uom: { type: Type.STRING, nullable: true, description: '计量单位，如 KG / CASE / PKT，没有则 null' },
        },
        required: ['productName'],
      },
    },
  },
  required: ['lines'],
} as const

const PROMPT = `你在阅读一份采购/供应商单据 PDF（发票、报价单或送货单）。

请只提取"商品明细表格"里的行，明确排除：
- 单据抬头/页眉页脚里的公司名、地址、电话、税号、邮箱
- 合计 / 小计 / 税额 / 运费 / 折扣等汇总行
- 页码、日期、单据编号这类非商品信息

对每一行商品给出：商品名称（原文照抄，不要翻译或改写）、数量、单价
（注意区分单价与行小计，同一行如果同时印了单价和小计要取单价）、计量单位（若单据上有写）。

另外找出这份单据的供应商/卖方公司名（不是收货方/买方），以及使用的币种（ISO 三位码）。
任何字段识别不到就给 null，不要编造数值或猜测。`

/** 模型按 RESPONSE_SCHEMA 吐出来的原始 JSON 形状（字段都当"可能没有"处理，不信任模型守约） */
export interface RawModelJson {
  supplierName?: string | null
  currency?: string | null
  lines?: Array<{ productName?: string; quantity?: number | null; unitCost?: number | null; uom?: string | null }>
}

// 本公司自身名称的已知写法——AI 常把单据抬头里"最显眼的公司名"当成供应商，
// 20260828 实测踩坑：gemini-3.1-flash-lite 把单据上印着的自家抬头 `JohnstoneBros`
// 当成了供应商（图省事只认最显眼的公司名，读对了字、认错了角色）。
// 确定性路径早就用「不拿第一行/最显眼文字当供应商」这条设计原则挡住了同一个坑
// （见 pdf-line-parser.ts detectSupplier 及其测试用例「不拿第一行当供应商」），
// AI 路径没有那层设计，所以这里补一道后置校验，直接拿这次踩的坑当规则用。
// 与 order-pdf.ts / purchase-order-pdf.ts / email.ts 里的写法保持一致，未抽公共常量
// （单租户系统，硬编码是既有约定）。
const OWN_COMPANY_NAMES = ['johnstone bros', 'johnstonebros']

function isOwnCompany(name: string): boolean {
  return OWN_COMPANY_NAMES.includes(name.toLowerCase().replace(/\s+/g, ' ').trim())
}

/**
 * 纯函数：把模型吐出来的 JSON 转成对外结果。不碰网络，单测直接喂固定 JSON 即可，
 * 不用 mock SDK/fetch —— 这次 JohnstoneBros 踩坑就是靠这个函数补的回归用例。
 */
export function buildResultFromModelJson(parsed: RawModelJson, suppliers: SupplierCandidate[]): AiPdfParseResult {
  const lines: ParsedPdfLine[] = (parsed.lines ?? [])
    .filter((l): l is { productName: string; quantity?: number | null; unitCost?: number | null; uom?: string | null } =>
      !!l?.productName?.trim())
    .map(l => ({
      productName: l.productName.trim(),
      quantity: typeof l.quantity === 'number' ? l.quantity : null,
      unitCost: typeof l.unitCost === 'number' ? l.unitCost : null,
      uom: l.uom?.trim() || null,
      raw: l.productName.trim(),
    }))

  // 供应商名同样只认「跟系统已有名单对上」——模型吐出来的字符串不能直接当 supplierId，
  // 与确定性路径 detectSupplier 的硬规则保持一致（宁可返回 null 让人选）。
  const supplierNameRaw = parsed.supplierName?.trim() || null
  const supplierName = supplierNameRaw && !isOwnCompany(supplierNameRaw) ? supplierNameRaw : null

  let supplierId: string | null = null
  if (supplierName) {
    const needle = supplierName.toLowerCase()
    const hit = suppliers.find(s => {
      const n = s.name.trim().toLowerCase()
      return n === needle || (n.length >= 4 && (needle.includes(n) || n.includes(needle)))
    })
    supplierId = hit?.id ?? null
  }

  const currency = parsed.currency?.trim() || null
  if (lines.length === 0) {
    return {
      lines: [], currency, supplierId, supplierName,
      error: 'AI 未能从这份 PDF 中识别出商品行，请改用默认识别或手工填单',
    }
  }

  return { lines, currency, supplierId, supplierName, error: null }
}

/**
 * @returns 未配置 GEMINI_API_KEY 时返回 { unavailable: true }，调用方应回退到
 *   确定性解析，而不是把这当成"识别出 0 行"处理——两者含义不同。
 */
export async function parsePdfWithGemini(
  pdfBuffer: Buffer,
  options: { suppliers: SupplierCandidate[] } = { suppliers: [] },
): Promise<AiPdfParseResult | AiPdfParseUnavailable> {
  const apiKey = process.env.GEMINI_API_KEY
  if (!apiKey) {
    return { unavailable: true, reason: '未配置 GEMINI_API_KEY，AI 辅助解析不可用' }
  }

  const ai = new GoogleGenAI({ apiKey })

  let responseText: string | undefined
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [{
        role: 'user',
        parts: [
          { text: PROMPT },
          { inlineData: { mimeType: 'application/pdf', data: pdfBuffer.toString('base64') } },
        ],
      }],
      config: {
        responseMimeType: 'application/json',
        responseSchema: RESPONSE_SCHEMA,
      },
    })
    responseText = response.text
  } catch (err) {
    console.error('[parsePdfWithGemini] generateContent failed', err)
    return {
      lines: [], currency: null, supplierId: null, supplierName: null,
      error: 'AI 解析调用失败，请改用默认识别或手工填单',
    }
  }

  if (!responseText) {
    return {
      lines: [], currency: null, supplierId: null, supplierName: null,
      error: 'AI 未返回可解析内容，请改用默认识别或手工填单',
    }
  }

  let parsed: RawModelJson
  try {
    parsed = JSON.parse(responseText)
  } catch (err) {
    console.error('[parsePdfWithGemini] response is not valid JSON', err, responseText.slice(0, 500))
    return {
      lines: [], currency: null, supplierId: null, supplierName: null,
      error: 'AI 返回内容不是合法 JSON，请改用默认识别或手工填单',
    }
  }

  return buildResultFromModelJson(parsed, options.suppliers)
}
