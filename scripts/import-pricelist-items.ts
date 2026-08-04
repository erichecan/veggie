/**
 * scripts/import-pricelist-items.ts
 *
 * 从 pic/product.pricelist.csv 解析 pricelist items 并写入数据库。
 *
 * 运行：
 *   node_modules/.bin/tsx scripts/import-pricelist-items.ts
 */

import { createPrismaClient } from '@/lib/prisma-factory'
import fs from 'fs'
import path from 'path'
import { randomUUID } from 'crypto'


const prisma = createPrismaClient()

// ── 内置 CSV 解析（不依赖第三方库）────────────────────────────────────────────

function parseCsv(raw: string): Record<string, string>[] {
  const lines = raw.split(/\r?\n/)
  if (lines.length < 2) return []

  const headers = splitCsvLine(lines[0])
  const result: Record<string, string>[] = []

  for (let i = 1; i < lines.length; i++) {
    const line = lines[i].trim()
    if (!line) continue
    const values = splitCsvLine(line)
    const row: Record<string, string> = {}
    for (let j = 0; j < headers.length; j++) {
      row[headers[j]] = values[j] ?? ''
    }
    result.push(row)
  }
  return result
}

function splitCsvLine(line: string): string[] {
  const result: string[] = []
  let current = ''
  let inQuotes = false

  for (let i = 0; i < line.length; i++) {
    const ch = line[i]
    if (ch === '"') {
      if (inQuotes && line[i + 1] === '"') {
        current += '"'
        i++
      } else {
        inQuotes = !inQuotes
      }
    } else if (ch === ',' && !inQuotes) {
      result.push(current.trim())
      current = ''
    } else {
      current += ch
    }
  }
  result.push(current.trim())
  return result
}

// ── CSV → 系统字段映射 ────────────────────────────────────────────────────────

function mapApplyOn(raw: string): 'global' | 'category' | 'product' | 'variant' {
  switch (raw.trim()) {
    case 'Product Variant': return 'variant'
    case 'Product':         return 'product'
    case 'Product Category':return 'category'
    default:                return 'global'
  }
}

function mapComputeType(raw: string): 'fixed' | 'percentage' | 'formula' {
  switch (raw.trim()) {
    case 'Fix Price':   return 'fixed'
    case 'Percentage':  return 'percentage'
    default:            return 'formula'
  }
}

function toNum(v: string, fallback = 0): number {
  const n = parseFloat(v)
  return isNaN(n) ? fallback : n
}

// ── 主逻辑 ────────────────────────────────────────────────────────────────────

async function main() {
  const csvPath = path.resolve(process.cwd(), 'pic/product.pricelist.csv')
  const raw = fs.readFileSync(csvPath, 'utf-8')

  const rows = parseCsv(raw)
  console.log(`📄 读取 ${rows.length} 行`)

  // 以 pricelist External ID 为 key，收集每张价格表的 items
  let currentPlExtId = ''
  const itemsMap = new Map<string, object[]>()

  for (const row of rows) {
    // 新价格表行（External ID 非空）
    if (row['External ID']) {
      currentPlExtId = row['External ID']
      if (!itemsMap.has(currentPlExtId)) {
        itemsMap.set(currentPlExtId, [])
      }
    }

    // 有 item 数据（Pricelist Items 非空）
    const itemExtId = row['Pricelist Items']
    if (!itemExtId || !currentPlExtId) continue

    const computeType = mapComputeType(row['Pricelist Items/Compute Price'] ?? '')
    const applyOn = mapApplyOn(row['Pricelist Items/Apply On'] ?? '')
    const fixedPrice = toNum(row['Pricelist Items/Fixed Price'])
    const minQty = toNum(row['Pricelist Items/Min. Quantity'])
    const priceMinMargin = toNum(row['Pricelist Items/Min. Price Margin'])
    const priceMaxMargin = toNum(row['Pricelist Items/Max. Price Margin'])
    const dateStart = row['Pricelist Items/Start Date']?.trim() || undefined
    const dateEnd = row['Pricelist Items/End Date']?.trim() || undefined

    const item: Record<string, unknown> = {
      id: randomUUID(),
      applyOn,
      minQty,
      computeType,
      sequence: 10,
      ...(dateStart ? { dateStart } : {}),
      ...(dateEnd ? { dateEnd } : {}),
      ...(computeType === 'fixed' ? { fixedPrice } : {}),
      ...(priceMinMargin !== 0 ? { priceMinMargin } : {}),
      ...(priceMaxMargin !== 0 ? { priceMaxMargin } : {}),
      ...(computeType === 'formula' ? {
        formulaBase: 'list_price',
        priceDiscount: 0,
        priceSurcharge: 0,
        roundingMethod: 0,
      } : {}),
    }

    itemsMap.get(currentPlExtId)!.push(item)
  }

  const totalItems = [...itemsMap.values()].reduce((s, a) => s + a.length, 0)
  console.log(`📋 解析完成：${itemsMap.size} 张价格表，合计 ${totalItems} 条 items`)

  // 写入数据库
  let updated = 0
  let skipped = 0

  for (const [extId, items] of itemsMap) {
    if (items.length === 0) { skipped++; continue }

    const existing = await prisma.odooPricelist.findUnique({
      where: { externalId: extId },
    })

    if (!existing) {
      console.warn(`  ⚠️  找不到价格表 ${extId}，跳过`)
      skipped++
      continue
    }

    await prisma.odooPricelist.update({
      where: { id: existing.id },
      data: { items: items as never },
    })
    updated++
  }

  console.log(`✅ 完成：更新 ${updated} 张价格表，跳过 ${skipped} 张`)
}

main()
  .catch(e => { console.error(e); process.exit(1) })
  .finally(() => prisma.$disconnect())
