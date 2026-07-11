import { NextResponse } from 'next/server'
import { Storage } from '@google-cloud/storage'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'

/**
 * POST /api/purchase-orders/pdf-extract
 * ============================================================================
 * 采购单新建页"上传 PDF 识别"：存档 → 抽文字层 → （有 Key 时）AI 结构化+非英文翻译成英文。
 * 返回的是"预填草稿"，前端必须让用户逐行核对后才能保存，不允许识别结果直接落库。
 */

const MAX_SIZE = 15 * 1024 * 1024 // 15 MB
const ALLOWED_ROLES = ['OPERATOR', 'BOSS', 'WAREHOUSE']

let _storage: Storage | null = null
function getStorage(): Storage {
  if (!_storage) _storage = new Storage()
  return _storage
}

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
      const bucketName = process.env.GCS_BUCKET_NAME ?? 'veggie-supply-images'
      const bucket = getStorage().bucket(bucketName)
      await bucket.file(objectPath).save(buffer, {
        contentType: 'application/pdf',
        metadata: { metadata: { uploadedBy: user.userId, uploadedByEmail: user.email } },
      })
      const sourceDocumentUrl = `https://storage.googleapis.com/${bucketName}/${objectPath}`

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

      try {
        const structured = await structureWithAI(rawText)
        return NextResponse.json({
          sourceDocumentUrl,
          sourceDocumentName: file.name,
          rawText,
          structured,
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
          aiUnavailable,
          error: aiUnavailable
            ? '尚未配置 AI（ANTHROPIC_API_KEY），仅展示 PDF 原文，请手动填单'
            : 'AI 识别失败，仅展示 PDF 原文，请手动填单',
        })
      }
    } catch (error) {
      console.error('[POST /api/purchase-orders/pdf-extract]', error)
      return NextResponse.json({ error: 'PDF 识别失败，请稍后重试' }, { status: 500 })
    }
  }, ALLOWED_ROLES)
}
