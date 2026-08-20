import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { serializeApi } from '@/lib/api-serializer'
import { getObjectStore } from '@/lib/storage/object-store'
import { parsePdfLines, type SupplierCandidate } from '@/lib/purchase/pdf-line-parser'
import { parseImportFile } from '@/lib/import-parser'
import { matchOne, matchStats, type MatchedLine } from '@/lib/purchase/product-match'

/**
 * POST /api/purchase-orders/parse
 * ============================================================================
 * 采购单据识别的**唯一**入口（20260819 收口）。取代此前并存的两条路径：
 *
 *   - `/api/purchase-orders/pdf-extract`（新建页用）—— 只认 PDF，且供应商/币种恒为 null
 *   - `/api/purchase-orders/import`（列表页 + 目录挑选页用）—— **识别完直接建 DRAFT 单**
 *
 * 后者是必须消灭的：它用双向子串匹配，实测把供应商单上的 `Harvest Beans`
 * 配成了库里的历史垃圾商品 `vest`，标成「模糊」**并直接落库**，未匹配的行
 * 则静默丢弃（5 行进 2 行，界面不说另外 3 行去哪了）。
 *
 * 所以这个接口有一条铁律：**只解析，绝不落库**。
 * 返回的是「预填草稿 + 匹配候选」，由人核对后在前端提交建单。
 *
 * ## 为什么没有 AI 兜底
 *
 * 原来的 pdf-extract 在确定性解析失败时会把原文发给 Claude 结构化。移除了，因为：
 *   1. 确定性解析现在自己就能认出**供应商、币种、商品行**（20260819 补齐），
 *      原先"只有 AI 能给供应商/币种"的理由已不成立；
 *   2. 生产从未配过 `ANTHROPIC_API_KEY`，这条分支在真实环境里一次都没跑过 ——
 *      留着只会让人误以为有兜底；
 *   3. 私有化部署（客户自有服务器）不该把供应商单据外发给第三方；
 *   4. 同一份 PDF 必须永远得到同一个结果，出错时能指着某一行说「这行没认出来」。
 *
 * 认不出来时返回 rawText + 明确的 error，让人手填 —— 比模型猜一个更可控。
 */

const MAX_SIZE = 15 * 1024 * 1024 // 15 MB
const PDF_EXT = /\.pdf$/i
const TABULAR_EXT = /\.(xlsx|xls|csv)$/i

interface ParsedRow {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
  /** 原文，供界面对照核对 —— 解析结果永远要能追溯回原始单据 */
  raw: string
}

export async function POST(req: Request) {
  const denied = rateLimit(req, { id: 'po-parse', max: 10, windowMs: 60_000 })
  if (denied) return denied

  return withAuth(req, async (user) => {
    try {
      const formData = await req.formData()
      const file = formData.get('file') as File | null

      if (!file) return NextResponse.json({ error: '未提供文件' }, { status: 400 })

      const isPdf = PDF_EXT.test(file.name) || file.type === 'application/pdf'
      const isTabular = TABULAR_EXT.test(file.name)
      if (!isPdf && !isTabular) {
        return NextResponse.json({ error: '仅支持 PDF / Excel / CSV 文件' }, { status: 400 })
      }
      if (file.size > MAX_SIZE) {
        return NextResponse.json({ error: '文件大小不能超过 15MB' }, { status: 400 })
      }

      const buffer = Buffer.from(await file.arrayBuffer())

      // 供应商与可采购商品：两者都要拿来做**确定性**匹配，所以在解析前先取。
      // 不可采购的商品不参与匹配 —— 匹配上了也不能下单，只会误导人。
      const [suppliers, products] = await Promise.all([
        prisma.customer.findMany({
          where: { isVendor: true, isActive: true },
          select: { id: true, name: true },
        }),
        prisma.product.findMany({
          where: { template: { canBePurchased: true }, status: 'ACTIVE' },
          select: { id: true, name: true, internalRef: true },
        }),
      ])

      let rows: ParsedRow[] = []
      let currency: string | null = null
      let supplierId: string | null = null
      let supplierName: string | null = null
      let rawText = ''
      let sourceDocumentUrl: string | null = null
      let diagnostics: unknown = null
      let parseError: string | null = null

      if (isPdf) {
        // 单据原件必须存档：识别结果有争议时要能翻回原文。
        // 走 object-store 抽象（默认本地磁盘），不直接依赖 GCS。
        const objectPath = `purchase-docs/${Date.now()}-${crypto.randomUUID()}.pdf`
        const stored = await getObjectStore().put(objectPath, buffer, 'application/pdf', {
          uploadedBy: user.userId,
          uploadedByEmail: user.email,
        })
        sourceDocumentUrl = stored.url

        const { PDFParse } = await import('pdf-parse')
        const parser = new PDFParse({ data: new Uint8Array(buffer) })
        rawText = (await parser.getText()).text ?? ''
        await parser.destroy()

        if (!rawText.trim()) {
          return NextResponse.json(serializeApi({
            sourceDocumentUrl, sourceDocumentName: file.name,
            rawText: '', lines: [], stats: null, diagnostics: null,
            currency: null, supplierId: null, supplierName: null,
            error: 'PDF 内容为空或是扫描图片，无法抽取文字层（本功能仅支持文字版 PDF）',
          }))
        }

        const parsed = parsePdfLines(rawText, { suppliers: suppliers as SupplierCandidate[] })
        rows = parsed.lines.map(l => ({
          productName: l.productName, quantity: l.quantity,
          unitCost: l.unitCost, uom: l.uom, raw: l.raw,
        }))
        currency = parsed.currency
        supplierId = parsed.supplierId
        supplierName = parsed.supplierName
        diagnostics = parsed.diagnostics
        parseError = parsed.error
      } else {
        let raw
        try {
          raw = await parseImportFile(file.name, buffer)
        } catch {
          return NextResponse.json({ error: '文件格式无法解析，请检查是否为标准 Excel / CSV' }, { status: 400 })
        }
        rows = raw.map(r => ({
          productName: r.rawProductName, quantity: r.quantity,
          unitCost: r.unitCost, uom: null,
          raw: `${r.rawProductName} / ${r.quantity} / ${r.unitCost}`,
        }))
        if (rows.length === 0) {
          parseError = '未能从表格中解析出商品行：请确认首行是表头，且含「商品名 / 数量 / 单价」三列。'
        }
      }

      // 商品匹配：歧义与未命中都如实返回候选，**不替人做决定**
      const lines = rows.map(r => {
        const m: MatchedLine = matchOne(r.productName, products)
        return { ...r, ...m }
      })

      return NextResponse.json(serializeApi({
        sourceDocumentUrl,
        sourceDocumentName: file.name,
        rawText,
        currency,
        supplierId,
        supplierName,
        lines,
        stats: matchStats(lines),
        diagnostics,
        error: parseError,
      }))
    } catch (error) {
      console.error('[POST /api/purchase-orders/parse]', error)
      return NextResponse.json({ error: '单据识别失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'purchase.order.create' })
}
