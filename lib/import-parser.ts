/**
 * 文件导入解析器（采购单 / 供应商账单复用）
 *
 * - parseImportFile: 解析 PDF / Excel / CSV，提取行项目（商品名、数量、单价）
 * - matchProducts:   按商品名对已有商品做精确 + 模糊匹配
 * - matchStats:      统计匹配情况（精确 / 模糊 / 未匹配）
 */

export interface RawLine {
  rawProductName: string
  quantity: number
  unitCost: number
}

export interface ParsedLine extends RawLine {
  matchedProductId: string | null
  matchedProductName: string | null
  confidence: 'exact' | 'fuzzy' | 'none'
}

export interface MatchStats {
  total: number
  exactMatch: number
  fuzzyMatch: number
  noMatch: number
}

/** 标准化字符串用于匹配 */
export function normalizeStr(s: string): string {
  return s.toLowerCase().replace(/\s+/g, '').replace(/[^\w一-鿿]/g, '')
}

/**
 * 根据文件名后缀选择解析器，提取行项目。
 * 不支持的格式会抛错，由调用方捕获并返回 400。
 */
export async function parseImportFile(fileName: string, buffer: Buffer): Promise<RawLine[]> {
  const lower = fileName.toLowerCase()
  if (lower.endsWith('.pdf')) return parsePdf(buffer)
  if (lower.endsWith('.xlsx') || lower.endsWith('.xls')) return parseExcel(buffer)
  if (lower.endsWith('.csv')) return parseCsv(buffer)
  throw new Error('UNSUPPORTED_FORMAT')
}

/** 对解析出的原始行按商品名做精确 + 模糊匹配 */
export function matchProducts(
  rawLines: RawLine[],
  allProducts: Array<{ id: string; name: string }>,
): ParsedLine[] {
  const productNameMap = new Map(allProducts.map(p => [normalizeStr(p.name), p]))

  return rawLines.map(raw => {
    const normalized = normalizeStr(raw.rawProductName)

    const exactMatch = productNameMap.get(normalized)
    if (exactMatch) {
      return {
        ...raw,
        matchedProductId: exactMatch.id,
        matchedProductName: exactMatch.name,
        confidence: 'exact' as const,
      }
    }

    const fuzzy = allProducts.find(p =>
      normalizeStr(p.name).includes(normalized) ||
      normalized.includes(normalizeStr(p.name)),
    )
    if (fuzzy) {
      return {
        ...raw,
        matchedProductId: fuzzy.id,
        matchedProductName: fuzzy.name,
        confidence: 'fuzzy' as const,
      }
    }

    return {
      ...raw,
      matchedProductId: null,
      matchedProductName: null,
      confidence: 'none' as const,
    }
  })
}

/** 统计匹配情况 */
export function matchStats(parsedLines: ParsedLine[]): MatchStats {
  return {
    total: parsedLines.length,
    exactMatch: parsedLines.filter(l => l.confidence === 'exact').length,
    fuzzyMatch: parsedLines.filter(l => l.confidence === 'fuzzy').length,
    noMatch: parsedLines.filter(l => l.confidence === 'none').length,
  }
}

/** 解析 PDF */
async function parsePdf(buffer: Buffer): Promise<RawLine[]> {
  const { PDFParse } = await import('pdf-parse')
  const parser = new PDFParse({ data: new Uint8Array(buffer) })
  const result = await parser.getText()
  await parser.destroy()
  const text = result.text

  const lines: RawLine[] = []
  const textLines = text.split('\n').map((l: string) => l.trim()).filter(Boolean)

  for (const line of textLines) {
    // 模式1: "商品名称    10    5.50" (tab/空格分隔)
    const match1 = line.match(/^(.+?)\s{2,}(\d+(?:\.\d+)?)\s{2,}(\d+(?:\.\d+)?)/)
    if (match1) {
      const qty = parseFloat(match1[2])
      const cost = parseFloat(match1[3])
      if (qty > 0 && cost >= 0 && match1[1].length > 1) {
        lines.push({ rawProductName: match1[1].trim(), quantity: qty, unitCost: cost })
        continue
      }
    }

    // 模式2: CSV-like "商品名,10,5.50"
    const parts = line.split(/[,;\t]/)
    if (parts.length >= 3) {
      const name = parts[0].trim()
      const qty = parseFloat(parts[1])
      const cost = parseFloat(parts[2])
      if (name.length > 1 && qty > 0 && Number.isFinite(cost) && cost >= 0) {
        lines.push({ rawProductName: name, quantity: qty, unitCost: cost })
      }
    }
  }

  return lines
}

/** 解析 Excel */
async function parseExcel(buffer: Buffer): Promise<RawLine[]> {
  const XLSX = await import('xlsx')
  const wb = XLSX.read(buffer, { type: 'buffer' })
  const sheetName = wb.SheetNames[0]
  if (!sheetName) return []

  const sheet = wb.Sheets[sheetName]
  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet, { defval: '' })

  const lines: RawLine[] = []

  const nameKeys = ['product', 'productname', 'name', 'item', '商品', '商品名', '品名', '商品名称', '名称', 'description', 'article']
  const qtyKeys = ['qty', 'quantity', '数量', 'amount', 'quantité', 'menge']
  const priceKeys = ['price', 'unitprice', 'unitcost', 'cost', '单价', '价格', 'prix', 'preis']

  for (const row of rows) {
    const keys = Object.keys(row)
    const nameKey = keys.find(k => nameKeys.includes(normalizeStr(k)))
    const qtyKey = keys.find(k => qtyKeys.includes(normalizeStr(k)))
    const priceKey = keys.find(k => priceKeys.includes(normalizeStr(k)))

    if (nameKey && qtyKey) {
      const name = String(row[nameKey]).trim()
      const qty = parseFloat(String(row[qtyKey]))
      const cost = priceKey ? parseFloat(String(row[priceKey])) : 0

      if (name.length > 0 && qty > 0 && Number.isFinite(qty)) {
        lines.push({
          rawProductName: name,
          quantity: qty,
          unitCost: Number.isFinite(cost) ? cost : 0,
        })
      }
    } else if (keys.length >= 2) {
      const vals = Object.values(row)
      const name = String(vals[0]).trim()
      const qty = parseFloat(String(vals[1]))
      const cost = vals.length >= 3 ? parseFloat(String(vals[2])) : 0

      if (name.length > 0 && qty > 0 && Number.isFinite(qty)) {
        lines.push({
          rawProductName: name,
          quantity: qty,
          unitCost: Number.isFinite(cost) ? cost : 0,
        })
      }
    }
  }

  return lines
}

/** 解析 CSV（文本） */
async function parseCsv(buffer: Buffer): Promise<RawLine[]> {
  const text = buffer.toString('utf-8')
  const lines: RawLine[] = []

  const rows = text.split('\n').map(l => l.trim()).filter(Boolean)
  if (rows.length <= 1) return lines // only header or empty

  const sep = rows[0].includes('\t') ? '\t' : rows[0].includes(';') ? ';' : ','

  const header = rows[0].split(sep).map(h => normalizeStr(h))
  const nameKeys = ['product', 'productname', 'name', 'item', '商品', '商品名', '品名', '商品名称', '名称']
  const qtyKeys = ['qty', 'quantity', '数量', 'amount']
  const priceKeys = ['price', 'unitprice', 'unitcost', 'cost', '单价', '价格']

  const nameIdx = header.findIndex(h => nameKeys.includes(h))
  const qtyIdx = header.findIndex(h => qtyKeys.includes(h))
  const priceIdx = header.findIndex(h => priceKeys.includes(h))

  const dataRows = (nameIdx >= 0 || qtyIdx >= 0) ? rows.slice(1) : rows

  for (const row of dataRows) {
    const cols = row.split(sep).map(c => c.trim().replace(/^["']|["']$/g, ''))
    const ni = nameIdx >= 0 ? nameIdx : 0
    const qi = qtyIdx >= 0 ? qtyIdx : 1
    const pi = priceIdx >= 0 ? priceIdx : 2

    if (cols.length < 2) continue
    const name = cols[ni]
    const qty = parseFloat(cols[qi] ?? '')
    const cost = cols[pi] ? parseFloat(cols[pi]) : 0

    if (name && name.length > 0 && qty > 0 && Number.isFinite(qty)) {
      lines.push({
        rawProductName: name,
        quantity: qty,
        unitCost: Number.isFinite(cost) ? cost : 0,
      })
    }
  }

  return lines
}
