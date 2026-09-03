/**
 * 询价单 / 报价单 PDF 商品行解析（台账 F2）
 * ============================================================================
 * 需求原话：「PDF 都是规整的电子版，只需把内容拆出来即可，**暂不上 AI 识别**，做最简方案」。
 *
 * 所以这里是**确定性解析**：纯函数，输入 pdf-parse 抽出来的文字层，输出商品行。
 * 不联网、不调模型 —— 同一份 PDF 永远解析出同一个结果，出错时能指着某一行说
 * 「这行没认出来」，而不是「模型这次没答对」。
 *
 * 两条策略，先表头后兜底：
 *   1. **表头驱动**：找到含「数量 / 品名 / 单价」这类关键词的表头行，按它确定列序，
 *      之后每行按同样的列序拆。规整电子版基本都能走这条。
 *   2. **模式兜底**：没有可识别表头时，退化成「一行里有文字 + 至少两个数」的通用模式，
 *      取第一个数当数量、最后一个金额当单价。
 *
 * ⛔ 合计行必须排除。`Subtotal €1.20` / `Total` / `VAT 0%` 这类行同样是
 * 「文字 + 数字」，不排掉就会变成一个叫「Subtotal」的商品混进采购单。
 */

export interface ParsedPdfLine {
  productName: string
  quantity: number | null
  unitCost: number | null
  uom: string | null
  /** 该行原文，界面上让人对照核对用 —— 解析结果永远要能追溯回原文 */
  raw: string
}

export interface PdfParseDiagnostics {
  /** 用了哪条策略 */
  strategy: 'header' | 'pattern' | 'none'
  /** 文字层总行数 */
  totalLines: number
  /** 认出来的商品行数 */
  matchedLines: number
  /** 被判为合计/税额等非商品行而跳过的行数 */
  skippedTotals: number
  /** 表头驱动时识别到的列序 */
  columns?: { qty?: number; name?: number; price?: number; uom?: number }
}

export interface PdfParseResult {
  lines: ParsedPdfLine[]
  diagnostics: PdfParseDiagnostics
  /** 人能读懂的失败原因；解析出行时为 null */
  error: string | null
  /** 识别到的币种 ISO 码（EUR/USD/GBP/CNY…），认不出为 null */
  currency: string | null
  /** 命中系统里已有的供应商时给出；只是从文字里读到名字但对不上库存供应商则为 null */
  supplierId: string | null
  /** 从文字层读到的供应商名原文（无论是否对得上系统供应商） */
  supplierName: string | null
}

/** 供 parsePdfLines 比对的候选供应商 */
export interface SupplierCandidate {
  id: string
  name: string
}

export interface ParsePdfOptions {
  /** 系统里已有的供应商；传了才可能返回 supplierId */
  suppliers?: SupplierCandidate[]
}

/** 合计/税额/页脚这类不是商品的行 */
const NON_PRODUCT_PATTERNS = [
  /^\s*(sub\s*total|total|subtotal)\b/i,
  /\bvat\b.*%/i,
  /^\s*(合计|小计|总计|税额|税金|运费|折扣)/,
  /^\s*(page|第)\s*[:：]?\s*\d+/i,
  // ⚠️ 20260902 实测：真实发票里页码常混在同一行文字末尾（`Sales Invoice  Page: 1/1`），
  // 不是独占一行——上面那条锚定行首的规则抓不到，加一条不锚定的。
  /\bpage\s*[:：]?\s*\d+\s*\/\s*\d+\b/i,
  /^\s*(tel|mail|web|e-?mail|address)\b/i,
  /^\s*(discount|shipping|freight|delivery\s+charge)\b/i,
  // ⚠️ 20260902 实测（真实供应商发票 Valstar）：银行/税号这类单据信息行同样是
  // 「文字 + 一串数字」，兜底模式的门槛（≥3个拉丁字母+≥2个数）拦不住，
  // 实测被解析成了一个把 IBAN 号当单价的假商品行。这几个词是有限、专有的词汇表，
  // 真实商品名撞上的概率接近零，穷举足够安全。
  /\b(iban|swift\s*code|bic\s*code|account\s*no|vat\s*(registration\s*)?no|coc\s*no|gln\s*no)\b/i,
]

/**
 * 表头关键词。**按 price → qty → name → uom 的顺序匹配，且是「包含」不是「全等」**：
 * 真实 PDF 里表头常常两个词挤进同一格（实测系统自己生成的采购单就是
 * `QTY UNIT | DESCRIPTION | UNIT COST | VAT | TOTAL`），
 * 全等匹配一个都认不出来，整张表就退化到兜底模式、单价取错。
 * 顺序要紧：`UNIT COST` 里既有 UNIT 又有 COST，先判价格才不会被当成单位列。
 */
const HEADER_KEYWORDS = {
  price: [/\bunit\s*cost\b/i, /\bunit\s*price\b/i, /\bprice\b/i, /单价/, /\bprecio/i, /\bpreis\b/i],
  qty: [/\bqty\b/i, /\bquantity\b/i, /数量/, /订购量/, /\bcant/i, /\bmenge\b/i],
  name: [/\bdescription\b/i, /\bproduct\b/i, /\bitem\b/i, /品名/, /商品/, /名称/, /\bdescripci/i, /\bartikel/i],
  uom: [/\bunit\b/i, /\buom\b/i, /单位/, /\bunidad/i],
} as const

/**
 * 金额/数量解析。**欧洲小数逗号是这里唯一真正的坑**：
 * `1.234,56` 是一千二百三十四点五六，`1,234.56` 也是 —— 两种写法数值相同但规则相反，
 * 按错的那套解析会把 1234.56 读成 1.23456 或 123456。
 * 判据：最后一个分隔符后面是不是恰好 3 位数字 —— 是则它是千分位，否则是小数点。
 */
export function parseNumber(raw: string): number | null {
  if (!raw) return null
  const cleaned = raw.replace(/[^\d.,\-]/g, '').trim()
  if (!cleaned || !/\d/.test(cleaned)) return null

  const lastComma = cleaned.lastIndexOf(',')
  const lastDot = cleaned.lastIndexOf('.')
  let normalized: string

  if (lastComma === -1 && lastDot === -1) {
    normalized = cleaned
  } else if (lastComma > lastDot) {
    // 逗号在后：逗号是小数点（欧陆写法 1.234,56）
    normalized = cleaned.replace(/\./g, '').replace(',', '.')
  } else if (lastDot > lastComma) {
    normalized = cleaned.replace(/,/g, '')
  } else {
    normalized = cleaned
  }

  // 只有一个逗号且后跟 3 位数字（1,234）→ 英式千分位。
  // ⚠️ **点号不做同样处理**：客户是爱尔兰实体，他们自己的单据把数量印成
  // 「1.000 LOOSE Courgette」意思是 1 件（三位小数），按千分位读会变成 1000 —— 差 1000 倍。
  // 代价是欧陆供应商写的「1.234」（意为 1234）会被读成 1.234。这个歧义**没有本地无关的解法**
  // （同一串字符在两种约定下含义相反），只能按客户所在地约定取一边，并在此写明。
  if (/^-?\d+,\d{3}$/.test(cleaned)) {
    normalized = cleaned.replace(/,/g, '')
  }

  const n = Number(normalized)
  return Number.isFinite(n) ? n : null
}

function isNonProductRow(line: string): boolean {
  return NON_PRODUCT_PATTERNS.some(re => re.test(line))
}

/** 按制表符或 2 个以上空格切列（pdf-parse 对规整表格通常给制表符） */
function splitCells(line: string): string[] {
  return line.split(/\t|\s{2,}/).map(c => c.trim()).filter(c => c.length > 0)
}

function matchHeader(cells: string[]): PdfParseDiagnostics['columns'] | null {
  const cols: PdfParseDiagnostics['columns'] = {}
  // 外层遍历关键词（保证 price 先于 uom 认领同一格），内层遍历列
  for (const [key, patterns] of Object.entries(HEADER_KEYWORDS) as Array<[keyof typeof HEADER_KEYWORDS, readonly RegExp[]]>) {
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i].trim()
      if (cols[key] === undefined && patterns.some(re => re.test(c))) { cols[key] = i; break }
    }
  }
  // 至少要认出「数量」和「单价」两列才算表头 —— 只认出品名的行多半是普通文字
  return cols.qty !== undefined && cols.price !== undefined ? cols : null
}

const MONEY_TOKEN = /[€$£¥]?\s*-?\d[\d.,]*/g

/**
 * 日期形态：2026-08-01 / 01/08/2026 / 2026.08.01 以及 12:30:00。
 * 兜底策略靠「一行里有两个以上数字」判定商品行，而一个日期本身就带三个数字 ——
 * 不先剥掉的话，「Supplier Quotation 2026-08-01」会变成一个商品（单测里就是这么翻车的）。
 */
/** 单据编号形态：字母(+数字) + 连字符 + 一串数字，如 F2-PO-1786510544939 / PO-00012 */
const CODE_LIKE = /\b[A-Za-z][A-Za-z0-9]{0,7}(?:-[A-Za-z0-9]+)*-\d{3,}\b/g

const DATE_LIKE = /\b\d{4}[-/.]\d{1,2}[-/.]\d{1,2}\b|\b\d{1,2}[-/.]\d{1,2}[-/.]\d{2,4}\b|\b\d{1,2}:\d{2}(:\d{2})?\b/g

/**
 * 币种识别（20260819 补）。原先只有 AI 兜底才给币种，确定性解析恒返回 null，
 * 采购每次都得手选 —— 而这件事根本不需要模型：符号与 ISO 码都是有限集。
 *
 * 顺序有讲究：**先认 ISO 码再认符号**。`$` 同时是 USD/CAD/AUD 的符号，
 * 单看符号只能猜 USD；但只要单据上写了 `CAD 120.00`，就该以 ISO 码为准。
 */
const CURRENCY_ISO = /\b(EUR|USD|GBP|CNY|RMB|JPY|PLN|SEK|DKK|CHF|CAD|AUD|NZD|HKD|SGD)\b/i
const CURRENCY_SYMBOL: Array<[RegExp, string]> = [
  [/€/, 'EUR'],
  [/£/, 'GBP'],
  [/¥|￥/, 'CNY'],
  [/\$/, 'USD'],
]

export function detectCurrency(rawText: string): string | null {
  const iso = rawText.match(CURRENCY_ISO)
  if (iso) {
    const code = iso[1].toUpperCase()
    return code === 'RMB' ? 'CNY' : code
  }
  for (const [re, code] of CURRENCY_SYMBOL) {
    if (re.test(rawText)) return code
  }
  return null
}

/**
 * 供应商识别（20260819 补）。同样不需要模型 —— 两条确定性线索就够：
 *
 *   1. **带标签的行**：`Supplier: X` / `Vendor: X` / `Proveedor: X` / `供应商：X`。
 *      多语言标签是个有限集，穷举即可。
 *   2. **系统已有供应商名直接出现在文字层里**。这条更硬 —— 它不是"猜名字"，
 *      而是拿库里的名单去正文里找，命中即确定，还能直接给出 supplierId。
 *
 * ⛔ 不做「取第一行当供应商名」这类启发式。PDF 第一行常常是**客户自己**的抬头
 *    （Johnstone Bros），猜错的代价是把采购单挂到错误的供应商上。宁可返回 null 让人选。
 */
const SUPPLIER_LABEL = /(?:supplier|vendor|proveedor|fournisseur|lieferant|供应商|供货商|卖方)\s*[:：]\s*(.+)/i

export function detectSupplier(
  rawText: string,
  suppliers: SupplierCandidate[] = [],
): { id: string | null; name: string | null } {
  // 线索 2 优先：能对上系统里的供应商，才是真正可用的结果。
  // 取「名字最长的那个命中」——`Asia Foods` 与 `Asia Foods Dublin` 同时出现在正文时，
  // 更长的那个是更具体的匹配。
  const haystack = rawText.toLowerCase()
  let best: SupplierCandidate | null = null
  for (const s of suppliers) {
    const n = s.name.trim().toLowerCase()
    // 少于 4 个字符的供应商名不参与正文扫描：太短会被正文里的任意片段命中
    if (n.length < 4) continue
    if (haystack.includes(n) && (!best || n.length > best.name.trim().length)) best = s
  }
  if (best) return { id: best.id, name: best.name }

  // 线索 1：带标签的行。读到了名字但对不上系统供应商，也如实回报，
  // 界面据此提示「识别到 X，未在系统中匹配到，请手动选择」。
  for (const line of rawText.split(/\r?\n/)) {
    const m = line.match(SUPPLIER_LABEL)
    if (!m) continue
    const raw = m[1].trim().replace(/\s{2,}/g, ' ')
    if (raw.length < 2) continue
    const hit = suppliers.find(s => {
      const n = s.name.trim().toLowerCase()
      return n.length >= 4 && (raw.toLowerCase().includes(n) || n.includes(raw.toLowerCase()))
    })
    return { id: hit?.id ?? null, name: hit?.name ?? raw }
  }

  return { id: null, name: null }
}

/**
 * 解析文字层。任何情况下都不会「静默返回空表」：
 * 认不出行时 error 里写明为什么、扫了多少行、跳过多少合计行。
 */
export function parsePdfLines(rawText: string, options: ParsePdfOptions = {}): PdfParseResult {
  const currency = detectCurrency(rawText ?? '')
  const supplier = detectSupplier(rawText ?? '', options.suppliers ?? [])
  const allLines = (rawText ?? '').split(/\r?\n/).map(l => l.trimEnd())
  const nonEmpty = allLines.filter(l => l.trim().length > 0)
  const diagnostics: PdfParseDiagnostics = {
    strategy: 'none', totalLines: nonEmpty.length, matchedLines: 0, skippedTotals: 0,
  }

  if (nonEmpty.length === 0) {
    return {
      lines: [], diagnostics, error: 'PDF 没有文字层（可能是扫描件），无法解析',
      currency, supplierId: supplier.id, supplierName: supplier.name,
    }
  }

  // ── 策略 1：表头驱动 ────────────────────────────────────────────────────
  let headerIdx = -1
  let cols: PdfParseDiagnostics['columns'] | null = null
  for (let i = 0; i < nonEmpty.length; i++) {
    const m = matchHeader(splitCells(nonEmpty[i]))
    if (m) { headerIdx = i; cols = m; break }
  }

  const lines: ParsedPdfLine[] = []

  if (cols && headerIdx >= 0) {
    diagnostics.strategy = 'header'
    diagnostics.columns = cols
    for (let i = headerIdx + 1; i < nonEmpty.length; i++) {
      const raw = nonEmpty[i]
      if (isNonProductRow(raw)) { diagnostics.skippedTotals++; continue }
      const cells = splitCells(raw)
      if (cells.length < 2) continue
      const qty = parseNumber(cells[cols.qty!] ?? '')
      const price = cols.price !== undefined ? parseNumber(cells[cols.price] ?? '') : null
      const name = (cols.name !== undefined ? cells[cols.name] : cells.find(c => /[A-Za-z一-龥]{2,}/.test(c))) ?? ''
      // 数量与名称是底线：两者缺一，这行就不是商品行
      if (qty === null || !name || !/[A-Za-z一-龥]/.test(name)) continue

      // ⚠️ 真实 PDF 里一行商品经常被**折成好几行**：客户那份单据的文字层就是
      //   `1.000 LOOSE Courgette LOOSE` / `角瓜` / `1.20 0% € 1.20`
      // 三行 —— 品名换行、价格被挤到下一行。只按物理行读，单价就永远是 null。
      // 所以往后看几行：纯文字的接到品名后面，纯数字的当作被挤下去的价格。
      let mergedName = name.trim()
      let mergedPrice = price
      let consumed = 0
      for (let j = i + 1; j < nonEmpty.length && consumed < 3 && mergedPrice === null; j++) {
        const next = nonEmpty[j]
        if (isNonProductRow(next)) break
        const nextCells = splitCells(next)
        // 下一行本身就是一条完整商品行（首列是数量且带文字）→ 停，别把它吃掉
        if (parseNumber(nextCells[cols.qty!] ?? '') !== null && /[A-Za-z一-龥]{2,}/.test(next)) break
        const hasText = /[A-Za-z一-龥]{2,}/.test(next)
        const numbers = (next.match(MONEY_TOKEN) ?? []).map(parseNumber).filter((n): n is number => n !== null)
        if (!hasText && numbers.length > 0) {
          mergedPrice = numbers[0]
          consumed++
          i = j          // 这些续行已被吃掉，主循环不要再当独立行处理
          break
        }
        if (hasText && numbers.length === 0) {
          mergedName = `${mergedName} ${next.trim()}`.trim()
          consumed++
          i = j
          continue
        }
        break
      }

      lines.push({
        productName: mergedName,
        quantity: qty,
        unitCost: mergedPrice,
        uom: cols.uom !== undefined ? (cells[cols.uom] ?? null) : null,
        raw,
      })
    }
  }

  // ── 策略 2：模式兜底（表头认不出，或表头驱动一行都没解出来）─────────────
  if (lines.length === 0) {
    diagnostics.strategy = 'pattern'
    diagnostics.skippedTotals = 0
    for (const raw of nonEmpty) {
      if (isNonProductRow(raw)) { diagnostics.skippedTotals++; continue }
      // 单号/编号（F2-PO-1786510544939、PO-00012）不是商品行，但它带一串数字，
      // 不剥掉会被兜底模式当成商品（实测把单号解析成了一个叫 "F -PO" 的货）
      const withoutDates = raw.replace(DATE_LIKE, ' ').replace(CODE_LIKE, ' ')
      const tokens = withoutDates.match(MONEY_TOKEN) ?? []
      const nums = tokens.map(parseNumber).filter((n): n is number => n !== null)
      const name = withoutDates.replace(MONEY_TOKEN, ' ').replace(/\s{2,}/g, ' ').trim()
      // 一行里至少要有两个数（数量 + 单价）和**一段像样的文字**，才当成商品行。
      // 门槛定在「3 个拉丁字母」或「2 个汉字」：低于这个，`-- 1 of 1 --`（页码）
      // 这种行会被当成一个叫 "of" 的商品 —— 实测就遇到过。
      const latin = (name.match(/[A-Za-z]/g) ?? []).length
      const cjk = (name.match(/[一-龥]/g) ?? []).length
      if (nums.length < 2 || (latin < 3 && cjk < 2)) continue
      // 单价取哪一个数：行里常见形态是「数量 单价 小计」，直接取最后一个会把**小计**
      // 当成单价（实测系统生成的采购单 PDF：15 × 5 = 75，误取 75）。
      // 判据不是猜位置，而是**验算**：若 数量 × 倒数第二个 ≈ 最后一个，
      // 那最后一个就是小计，单价是倒数第二个。
      const qtyGuess = nums[0]
      const last = nums[nums.length - 1]
      const secondLast = nums.length >= 3 ? nums[nums.length - 2] : null
      const looksLikeLineTotal = secondLast !== null
        && Math.abs(qtyGuess * secondLast - last) <= Math.max(0.01, Math.abs(last) * 0.001)
      lines.push({
        productName: name,
        quantity: qtyGuess,
        unitCost: looksLikeLineTotal ? secondLast : last,
        uom: null,
        raw,
      })
    }
  }

  diagnostics.matchedLines = lines.length
  if (lines.length === 0) {
    diagnostics.strategy = 'none'
    return {
      lines: [],
      diagnostics,
      // ⛔ 这里绝不能返回「空表 + 200」。静默出空表的话，采购会以为这份 PDF 里
      // 真的没有商品，而不是「我们没解析出来」——两者要采取的行动完全不同。
      error: `未能从 PDF 文字层解析出商品行（扫描了 ${diagnostics.totalLines} 行，跳过 ${diagnostics.skippedTotals} 行合计/页脚）。`
        + '该 PDF 的表格结构可能与常见格式差异较大，请手工填单，并把这份 PDF 留给开发补规则。',
      currency, supplierId: supplier.id, supplierName: supplier.name,
    }
  }

  return { lines, diagnostics, error: null, currency, supplierId: supplier.id, supplierName: supplier.name }
}
