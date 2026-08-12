import { NextResponse } from 'next/server'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { getObjectStore } from '@/lib/storage/object-store'
import { parsePdfLines } from '@/lib/purchase/pdf-line-parser'

/**
 * POST /api/purchase-orders/pdf-extract
 * ============================================================================
 * 采购单新建页"上传 PDF 识别"：存档 → 抽文字层 → **确定性解析**（台账 F2）→
 * 解析不出来时，若配了 AI Key 再退而求其次交给模型。
 * 返回的是"预填草稿"，前端必须让用户逐行核对后才能保存，不允许识别结果直接落库。
 *
 * ⛔ 顺序是刻意的。需求原话是「PDF 都是规整的电子版……**暂不上 AI 识别**，做最简方案」：
 * 确定性解析同一份 PDF 永远得同一个结果，错了能指着某一行说「这行没认出来」；
 * 模型则每次可能不同，且没 Key 的环境（私有化部署）根本跑不了。所以 AI 只当兜底。
 *
 * 存档走 lib/storage/object-store 抽象（默认落本地磁盘），**不直接依赖 GCS** ——
 * 台账里记的那条「现有实现依赖 @google-cloud/storage」已不成立，本轮复核过。
 */

const MAX_SIZE = 15 * 1024 * 1024 // 15 MB
const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'WAREHOUSE']

interface ExtractedLine {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
}

interface StructuredResult {
  supplierGuess: string | null
  currencyGuess: string | null
  lines: ExtractedLine[]
  translationNote: string | null
}

const STRUCTURE_PROMPT = `你是采购单据识别助手。下面是一份供应商报价单/采购单 PDF 的原始文字内容，可能是西班牙语、法语或其他语种。
请完成：
1. 识别供应商名称（若能判断）
2. 识别币种（ISO 代码，如 EUR/USD，若能判断）
3. 逐行提取商品行：商品名称（如果不是英文，翻译成英文；原文和译文都保留在 productName 里，格式"英文译名 (原文)"）、数量、单价、计量单位
4. 只输出 JSON，不要任何解释文字，格式：
{"supplierGuess": string|null, "currencyGuess": string|null, "lines": [{"productName": string, "quantity": number|null, "unitCost": number|null, "uom": string|null}], "translationNote": string|null}

原始文字内容：
`

async function extractPdfText(buffer: Buffer): Promise<string> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  await parser.destroy()
  return result.text
}

async function structureWithAI(rawText: string): Promise<StructuredResult> {
  const apiKey = process.env.ANTHROPIC_API_KEY
  if (!apiKey) {
    throw Object.assign(new Error('AI_NOT_CONFIGURED'), { code: 'AI_NOT_CONFIGURED' })
  }

  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: 'claude-sonnet-5',
      max_tokens: 4096,
      messages: [{ role: 'user', content: STRUCTURE_PROMPT + rawText.slice(0, 12000) }],
    }),
  })

  if (!res.ok) {
    const detail = await res.text().catch(() => '')
    throw new Error(`Anthropic API ${res.status}: ${detail.slice(0, 200)}`)
  }

  const json = await res.json()
  const text = json?.content?.[0]?.text ?? ''
  const match = text.match(/\{[\s\S]*\}/)
  if (!match) throw new Error('AI 返回内容无法解析为 JSON')

  const parsed = JSON.parse(match[0])
  return {
    supplierGuess: parsed.supplierGuess ?? null,
    currencyGuess: parsed.currencyGuess ?? null,
    lines: Array.isArray(parsed.lines) ? parsed.lines : [],
    translationNote: parsed.translationNote ?? null,
  }
}

export async function POST(req: Request) {
  const denied = rateLimit(req, { id: 'pdf-extract', max: 10, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null

      if (!file) return NextResponse.json({ error: '未提供文件' }, { status: 400 })
      if (file.type !== 'application/pdf') {
        return NextResponse.json({ error: '仅支持 PDF 文件' }, { status: 400 })
      }
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: 'PDF 大小不能超过 15MB' }, { status: 400 })
      }

      const buffer = Buffer.from(await file.arrayBuffer())

      const objectPath = `purchase-docs/${Date.now()}-${crypto.randomUUID()}.pdf`
      const { url: sourceDocumentUrl } = await getObjectStore().put(
        objectPath,
        buffer,
        'application/pdf',
        { uploadedBy: user.userId, uploadedByEmail: user.email },
      )

      const rawText = await extractPdfText(buffer)
      if (!rawText.trim()) {
        return NextResponse.json({
          sourceDocumentUrl,
          sourceDocumentName: file.name,
          rawText: '',
          structured: null,
          aiUnavailable: false,
          error: 'PDF 内容为空或是扫描图片，无法抽取文字层（本功能仅支持文字版 PDF）',
        }, { status: 200 })
      }

      // ① 确定性解析（不联网、不调模型）
      const parsed = parsePdfLines(rawText)
      if (parsed.lines.length > 0) {
        return NextResponse.json({
          sourceDocumentUrl,
          sourceDocumentName: file.name,
          rawText,
          structured: {
            supplierGuess: null,
            currencyGuess: null,
            lines: parsed.lines.map(l => ({
              productName: l.productName,
              quantity: l.quantity,
              unitCost: l.unitCost,
              uom: l.uom,
            })),
            translationNote: null,
          },
          source: 'parser',
          diagnostics: parsed.diagnostics,
          aiUnavailable: false,
        })
      }

      // ② 兜底：确定性解析认不出来时才考虑 AI
      try {
        const structured = await structureWithAI(rawText)
        return NextResponse.json({
          sourceDocumentUrl,
          sourceDocumentName: file.name,
          rawText,
          structured,
          source: 'ai',
          diagnostics: parsed.diagnostics,
          // 解析器没认出来这件事要如实说，不能因为 AI 兜住了就当无事发生 ——
          // 否则没人知道该去给解析器补规则
          parserError: parsed.error,
          aiUnavailable: false,
        })
      } catch (err) {
        const aiUnavailable = (err as { code?: string })?.code === 'AI_NOT_CONFIGURED'
        console.error('[pdf-extract] AI structuring failed:', err)
        return NextResponse.json({
          sourceDocumentUrl,
          sourceDocumentName: file.name,
          rawText,
          structured: null,
          source: 'none',
          diagnostics: parsed.diagnostics,
          aiUnavailable,
          // ⛔ 这里必须给出**具体**原因（扫了多少行、跳过多少合计行），
          // 不能只回一张空表 —— 采购分不清「这份 PDF 没有商品」和「我们没解析出来」，
          // 而这两种情况该做的事完全不同
          error: `${parsed.error ?? '未能解析出商品行'}${
            aiUnavailable ? '（本环境未配置 AI 兜底）' : '（AI 兜底也未成功）'
          }`,
        })
      }
    } catch (error) {
      console.error('[POST /api/purchase-orders/pdf-extract]', error)
      return NextResponse.json({ error: 'PDF 识别失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'purchase.order.create' })
}
