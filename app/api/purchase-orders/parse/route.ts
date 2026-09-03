import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { rateLimit } from '@/lib/rate-limit'
import { serializeApi } from '@/lib/api-serializer'
import { getObjectStore } from '@/lib/storage/object-store'
import { parsePdfLines, type SupplierCandidate } from '@/lib/purchase/pdf-line-parser'
import { parsePdfWithGemini } from '@/lib/purchase/ai-pdf-parser'
import { parseImportFile } from '@/lib/import-parser'
import { matchOne, matchStats, normalizeName, type MatchedLine } from '@/lib/purchase/product-match'
import { findAliasMatches } from '@/lib/purchase/product-alias'

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
 * ## 引擎选择：AI 优先，确定性解析兜底（20260902 起）
 *
 * 20260819 客户曾拍板「尽量不用 AI 兜底」，理由见下方历史记录；20260828 加了
 * `engine=ai` 原型对比效果后，20260902 客户已确认接受把供应商单据发给 Google
 * Gemini 解析，**AI 转正为默认引擎**（`engine` 不传或传 `ai` 都走 AI；显式传
 * `deterministic` 才退回纯规则解析）。原因：
 *   1. 真实单据版式远比规整电子发票复杂（表头跨多行、多语言、拍照件），
 *      纯正则的确定性解析在这类单据上会把发票号、IBAN、VAT 号这类"单据信息"
 *      误判成商品行——这正是确定性解析这条路线本身的局限，不是没写全规则；
 *   2. **拍照的纸质单据（jpg/png）只能走这条路径**——正则做不了 OCR；
 *   3. 没配 `GEMINI_API_KEY`、或调用失败时自动回退到确定性解析（仅 PDF 有效，
 *      图片没有可回退的确定性路径，直接报错让人手填）。
 *
 * ### 历史：为什么曾经没有 AI 兜底
 * 原来的 pdf-extract 在确定性解析失败时会把原文发给 Claude 结构化，20260819 移除，
 * 因为彼时确定性解析刚补齐供应商/币种识别、生产从未配过 key、且私有化部署单据外发
 * 第三方是待客户拍板的政策问题——第三条现已由客户 20260902 拍板同意，其余两条
 * 已被本轮的真实单据测试证伪（确定性解析在复杂单据上仍会把单据信息当商品）。
 */

const MAX_SIZE = 15 * 1024 * 1024 // 15 MB
const PDF_EXT = /\.pdf$/i
const IMAGE_EXT = /\.(jpe?g|png)$/i
const TABULAR_EXT = /\.(xlsx|xls|csv)$/i
const IMAGE_MIME: Record<string, string> = { jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png' }

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
      // 20260902：AI 转正为默认，只有显式传 deterministic 才退回纯规则解析。
      const engine = (formData.get('engine') as string | null) === 'deterministic' ? 'deterministic' : 'ai'

      if (!file) return NextResponse.json({ error: '未提供文件' }, { status: 400 })

      const isPdf = PDF_EXT.test(file.name) || file.type === 'application/pdf'
      const isImage = IMAGE_EXT.test(file.name) || /^image\/(jpe?g|png)$/.test(file.type)
      const isTabular = TABULAR_EXT.test(file.name)
      if (!isPdf && !isImage && !isTabular) {
        return NextResponse.json({ error: '仅支持 PDF / 图片(jpg、png) / Excel / CSV 文件' }, { status: 400 })
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
          // 归档只影响能不能被销售选中，不影响能不能被采购——
          // 只要 canBePurchased 还开着，供应商单据里的写法就该继续匹配得上。
          where: { canBePurchased: true },
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
      let engineUsed: 'ai' | 'deterministic' | 'unavailable' = 'deterministic'

      if (isPdf || isImage) {
        // 单据原件必须存档：识别结果有争议时要能翻回原文。
        // 走 object-store 抽象（默认本地磁盘），不直接依赖 GCS。
        const ext = isPdf ? 'pdf' : (file.name.split('.').pop() ?? 'jpg').toLowerCase()
        const mimeType = isPdf ? 'application/pdf' : (IMAGE_MIME[ext] ?? 'image/jpeg')
        const objectPath = `purchase-docs/${Date.now()}-${crypto.randomUUID()}.${ext}`
        const stored = await getObjectStore().put(objectPath, buffer, mimeType, {
          uploadedBy: user.userId,
          uploadedByEmail: user.email,
        })
        sourceDocumentUrl = stored.url

        // 文字层只有 PDF 才可能有；图片（拍照单据）从不存在文字层，也就没有
        // 确定性解析可回退——纯正则做不了 OCR。
        if (isPdf) {
          const { PDFParse } = await import('pdf-parse')
          const parser = new PDFParse({ data: new Uint8Array(buffer) })
          rawText = (await parser.getText()).text ?? ''
          await parser.destroy()
        }

        // 显式选择确定性解析时，没有文字层就直接报错（不联网，也没有别的路可走）。
        if (engine === 'deterministic' && !rawText.trim()) {
          return NextResponse.json(serializeApi({
            sourceDocumentUrl, sourceDocumentName: file.name,
            rawText: '', lines: [], stats: null, diagnostics: null,
            currency: null, supplierId: null, supplierName: null,
            error: isImage
              ? '图片没有可用的确定性解析路径，请改用 AI 识别或手工填单'
              : 'PDF 内容为空或是扫描图片，无法抽取文字层，请改用 AI 识别或手工填单',
          }))
        }

        // 默认走 AI：直接把原始文件（PDF 或图片）作为多模态输入喂给模型，
        // 版面结构本身就是"这行是商品还是地址"的强信号。没配 key 或调用失败
        // 都不当成"识别出 0 行"——PDF 还能回退到确定性解析，图片没有退路，直接报错让人手填。
        let usedAi = false
        let aiFallbackNotice: string | null = null
        if (engine === 'ai') {
          const aiResult = await parsePdfWithGemini(buffer, { suppliers: suppliers as SupplierCandidate[] }, mimeType)
          if ('unavailable' in aiResult) {
            aiFallbackNotice = isPdf ? `${aiResult.reason}，已自动改用默认识别` : aiResult.reason
          } else {
            usedAi = true
            rows = aiResult.lines.map(l => ({
              productName: l.productName, quantity: l.quantity,
              unitCost: l.unitCost, uom: l.uom, raw: l.raw,
            }))
            currency = aiResult.currency
            supplierId = aiResult.supplierId
            supplierName = aiResult.supplierName
            diagnostics = { strategy: 'ai' as const, matchedLines: rows.length }
            parseError = aiResult.error
          }
        }

        if (!usedAi && isImage) {
          engineUsed = 'unavailable'
          parseError = aiFallbackNotice ?? 'AI 识别不可用，图片没有其他可用的解析路径，请手工填单'
        } else if (!usedAi) {
          if (!rawText.trim()) {
            parseError = `${aiFallbackNotice ?? 'AI 识别未返回结果'}；PDF 无文字层（可能是扫描件），确定性解析也无法回退，请手工填单`
            engineUsed = 'unavailable'
          } else {
            const parsed = parsePdfLines(rawText, { suppliers: suppliers as SupplierCandidate[] })
            rows = parsed.lines.map(l => ({
              productName: l.productName, quantity: l.quantity,
              unitCost: l.unitCost, uom: l.uom, raw: l.raw,
            }))
            currency = parsed.currency
            supplierId = parsed.supplierId
            supplierName = parsed.supplierName
            diagnostics = parsed.diagnostics
            parseError = aiFallbackNotice ? [aiFallbackNotice, parsed.error].filter(Boolean).join('；') : parsed.error
            engineUsed = 'deterministic'
          }
        } else {
          engineUsed = 'ai'
        }
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

      // 商品匹配：先查「原文 → 商品」记忆表（操作员之前手动挑过的写法，含外语），
      // 命中就直接精确匹配；没命中的行才走 token 匹配。歧义与未命中都如实返回候选，
      // **不替人做决定**
      const aliasMap = await findAliasMatches(rows.map(r => r.productName))
      const lines = rows.map(r => {
        const alias = aliasMap.get(normalizeName(r.productName))
        if (alias) {
          const m: MatchedLine = {
            matchedProductId: alias.productId, matchedProductName: alias.productName,
            confidence: 'exact', candidates: [{ id: alias.productId, name: alias.productName, score: 1 }],
            ambiguous: false,
          }
          return { ...r, ...m, fromAlias: true }
        }
        const m: MatchedLine = matchOne(r.productName, products)
        return { ...r, ...m, fromAlias: false }
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
        engineUsed,
      }))
    } catch (error) {
      console.error('[POST /api/purchase-orders/parse]', error)
      return NextResponse.json({ error: '单据识别失败，请稍后重试' }, { status: 500 })
    }
  }, { require: 'purchase.order.create' })
}
