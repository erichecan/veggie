import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { normalizeAndValidateSaleUomItems, upsertProductSaleUomRows } from '@/lib/product-sale-uom-upsert'
import type { SaleUomItemInput } from '@/lib/sale-uom'
import {
  runBulkImport, str, num, boundedNum, bool, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine,
  normalizeNameKey, type MatchKeyDef,
} from '@/lib/import/bulk-import-engine'

/**
 * POST /api/products/bulk — 商品批量导入(CSV，20260930 重写、20261 补 productNo 匹配键、
 * 20261003 改走全站通用的 lib/import/bulk-import-engine.ts；循环控制/匹配优先级回退/
 * 错误收集抽到引擎里，这里只保留商品字段解析与写库逻辑)
 * ============================================================================
 * body: { rows: [{ name*, productNo?, internalRef?, barcode?, externalId?, spec?,
 *   description?, saleDescription?, category?, type?, canBeSold?, canBePurchased?,
 *   listPrice?, standardPrice?, customerTaxRate?, vendorTaxRate?, commissionPrice?,
 *   weight?, netWeight?, volume?, qtyOnHand?, uomName?, purchaseUomName?, tracking?,
 *   status?, saleUoms? }] }
 *
 * 与 lib/export/columns/product-templates.ts 导出的列一一对应(同一套人类可读的
 * category/uomName/purchaseUomName/saleUoms "UomName:factor:Y|N" 摘要格式)，
 * 导出 → Excel 改 → 重新导入这条路径两边共用同一套口径。
 *
 * 更新-或-创建匹配优先级：productNo → internalRef → barcode → externalId(仅精确匹配
 * 才触发更新)；都没匹配上时落回旧行为——按名字大小写不敏感判重，撞了就跳过(不覆盖)。
 * 更新时只覆盖本行提供了非空值的字段，不会用默认值把已有数据冲掉。
 *
 * productNo 是数据库自增主键，只用来"查找该更新哪一条"，绝不会被写进 create/update
 * 的 data 里——它本身是只读字段，这个端点永远不会去改它或生成它。
 */

const MAX_ROWS_PER_REQUEST = 500

type ProductTypeValue = 'PRODUCT' | 'CONSU' | 'SERVICE'
type ProductStatusValue = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'

const TYPE_VALUES: Record<string, ProductTypeValue> = { product: 'PRODUCT', consu: 'CONSU', service: 'SERVICE' }
const STATUS_VALUES: Record<string, ProductStatusValue> = { draft: 'DRAFT', active: 'ACTIVE', archived: 'ARCHIVED' }

function describeRowError(e: unknown, row: { externalId?: string }): string {
  if (isUniqueConstraintError(e)) {
    return row.externalId
      ? `ID '${row.externalId}' is already used by another product, row not imported`
      : 'a unique field is already used by another product, row not imported'
  }
  if (isTransactionTimeoutError(e)) {
    return 'database timed out, row not imported — please re-import this row'
  }
  return lastErrorLine(e)
}

interface SaleUomEntry { uomName: string; factor: number; spec?: string; sequence?: number; grossWeight?: number }

/**
 * 解析导出侧 "UomName:factor:Y|N[:spec[:sequence[:grossWeight]]]" 摘要格式(分号分隔，
 * 与 lib/export/loaders/product-templates.ts 的 saleUomsSummary 逐字对应)。
 * 前 3 段(单位名/系数/是否默认)必填，spec/装货顺序/毛重 3 段可选、可省略、可留空。
 * 坏段落只跳过那一段，不让整行导入失败。
 */
function parseSaleUomsSummary(raw: string): { entries: SaleUomEntry[]; malformed: string[] } {
  const entries: SaleUomEntry[] = []
  const malformed: string[] = []
  for (const part of raw.split(';')) {
    const seg = part.trim()
    if (!seg) continue
    const bits = seg.split(':')
    if (bits.length < 3) { malformed.push(seg); continue }
    const name = bits[0].trim()
    const factor = Number(bits[1].trim())
    if (!name || !Number.isFinite(factor) || factor <= 0) { malformed.push(seg); continue }
    const entry: SaleUomEntry = { uomName: name, factor }
    const specRaw = bits[3]?.trim()
    if (specRaw) entry.spec = specRaw
    const seqRaw = bits[4]?.trim()
    if (seqRaw) {
      const seq = Number(seqRaw)
      if (Number.isInteger(seq) && seq >= 0 && seq <= 8) entry.sequence = seq
    }
    const gwRaw = bits[5]?.trim()
    if (gwRaw) {
      const gw = Number(gwRaw)
      if (Number.isFinite(gw) && gw >= 0) entry.grossWeight = gw
    }
    entries.push(entry)
  }
  return { entries, malformed }
}

interface ResolvedRow {
  rowLabel: string
  name: string
  productNo?: number
  internalRef?: string
  barcode?: string
  externalId?: string
  spec?: string
  description?: string
  saleDescription?: string
  categoryId?: string
  type?: ProductTypeValue
  canBeSold?: boolean
  canBePurchased?: boolean
  listPrice?: number
  standardPrice?: number
  customerTaxRate?: number
  vendorTaxRate?: number
  commissionPrice?: number
  weight?: number
  netWeight?: number
  volume?: number
  qtyOnHand?: number
  uomId?: string
  purchaseUomId?: string
  tracking?: string
  status?: ProductStatusValue
  saleUomItems?: SaleUomItemInput[]
}

export async function POST(req: Request) {
  return withAuth(req, async (user) => {
    try {
      const data = await req.json()
      const rawRows = Array.isArray(data.rows) ? data.rows : []
      if (rawRows.length === 0) return NextResponse.json({ error: 'rows 不能为空' }, { status: 400 })
      if (rawRows.length > MAX_ROWS_PER_REQUEST) {
        return NextResponse.json({ error: `单次请求最多 ${MAX_ROWS_PER_REQUEST} 行(导入弹窗会自动分批提交)` }, { status: 400 })
      }
      const rowOffset = Number.isInteger(data.rowOffset) && data.rowOffset >= 0 ? data.rowOffset as number : 0

      // ── 预取匹配用的字典：分类 / 单位(中英文名均可命中，大小写不敏感) ──────────
      const [categories, uoms] = await Promise.all([
        prisma.productCategory.findMany({ select: { id: true, name: true, nameZh: true } }),
        prisma.uom.findMany({ select: { id: true, name: true, nameZh: true } }),
      ])
      const categoryByName = new Map<string, string>()
      for (const c of categories) {
        if (c.name) categoryByName.set(normalizeNameKey(c.name), c.id)
        if (c.nameZh) categoryByName.set(normalizeNameKey(c.nameZh), c.id)
      }
      const uomByName = new Map<string, string>()
      for (const u of uoms) {
        if (u.name) uomByName.set(normalizeNameKey(u.name), u.id)
        if (u.nameZh) uomByName.set(normalizeNameKey(u.nameZh), u.id)
      }

      // 价格变更留痕(#22)用的"改前价"：按商品 id 累积，每成功更新一行就刷新一次——
      // 同一份文件里两行改同一个商品时，第二行的"改前"才是第一行改完的值。
      const currentPrices = new Map<string, { listPrice: unknown; standardPrice: unknown }>()

      const matchKeys: MatchKeyDef<ResolvedRow>[] = [
        { field: 'productNo', get: r => r.productNo },
        { field: 'internalRef', get: r => r.internalRef },
        { field: 'barcode', get: r => r.barcode },
        { field: 'externalId', get: r => r.externalId },
      ]

      const result = await runBulkImport<Record<string, unknown>, ResolvedRow, { name: string; listPrice: unknown; standardPrice: unknown }>({
        rawRows,
        rowOffset,
        matchKeys,

        resolveRow(r, rowNo, warn) {
          const name = str(r.name, 200)
          if (!name) { warn(`Row ${rowNo}: missing required 'name', skipped`); return null }
          const rowLabel = `Row ${rowNo} (${name})`
          const row: ResolvedRow = { rowLabel, name }

          const productNoRaw = num(r.productNo)
          if (productNoRaw !== undefined) {
            if (Number.isInteger(productNoRaw) && productNoRaw > 0) row.productNo = productNoRaw
            else warn(`${rowLabel}: Product No. '${r.productNo}' is not a valid positive integer, ignored`)
          }

          row.internalRef = str(r.internalRef, 100)
          row.barcode = str(r.barcode, 100)
          row.externalId = str(r.externalId, 100)
          row.spec = str(r.spec, 200)
          row.description = str(r.description, 5000)
          row.saleDescription = str(r.saleDescription, 5000)
          row.tracking = str(r.tracking, 50)

          const categoryName = str(r.category, 200)
          if (categoryName) {
            const id = categoryByName.get(normalizeNameKey(categoryName))
            if (id) row.categoryId = id
            else warn(`${rowLabel}: category '${categoryName}' not found, left unset`)
          }

          const typeRaw = str(r.type, 20)?.toLowerCase()
          if (typeRaw) {
            const mapped = TYPE_VALUES[typeRaw]
            if (mapped) row.type = mapped
            else warn(`${rowLabel}: type '${typeRaw}' not recognized, ignored`)
          }

          const statusRaw = str(r.status, 20)?.toLowerCase()
          if (statusRaw) {
            const mapped = STATUS_VALUES[statusRaw]
            if (mapped) row.status = mapped
            else warn(`${rowLabel}: status '${statusRaw}' not recognized, ignored`)
          }

          const canBeSold = bool(r.canBeSold)
          if (canBeSold.invalid) warn(`${rowLabel}: canBeSold value not recognized, ignored`)
          row.canBeSold = canBeSold.value

          const canBePurchased = bool(r.canBePurchased)
          if (canBePurchased.invalid) warn(`${rowLabel}: canBePurchased value not recognized, ignored`)
          row.canBePurchased = canBePurchased.value

          const listPrice = boundedNum(r.listPrice, 0, 1_000_000)
          if (listPrice.invalid) warn(`${rowLabel}: listPrice out of range (0-1,000,000), ignored`)
          row.listPrice = listPrice.value

          // ⛔ 老 bulk-import 从不设置 standardPrice，商品落库成 null，详情页曾对
          // null.toFixed() 崩溃(已防御性修复，但导入这里仍须给出合理默认值 0)。
          const standardPrice = boundedNum(r.standardPrice, 0, 1_000_000)
          if (standardPrice.invalid) warn(`${rowLabel}: standardPrice out of range (0-1,000,000), ignored`)
          row.standardPrice = standardPrice.value

          const customerTaxRate = boundedNum(r.customerTaxRate, 0, 1)
          if (customerTaxRate.invalid) warn(`${rowLabel}: customerTaxRate out of range (0-1), ignored`)
          row.customerTaxRate = customerTaxRate.value

          const vendorTaxRate = boundedNum(r.vendorTaxRate, 0, 1)
          if (vendorTaxRate.invalid) warn(`${rowLabel}: vendorTaxRate out of range (0-1), ignored`)
          row.vendorTaxRate = vendorTaxRate.value

          row.commissionPrice = num(r.commissionPrice)
          row.weight = num(r.weight)
          row.netWeight = num(r.netWeight)
          row.volume = num(r.volume)
          row.qtyOnHand = num(r.qtyOnHand)

          const uomName = str(r.uomName, 200)
          if (uomName) {
            const id = uomByName.get(normalizeNameKey(uomName))
            if (id) row.uomId = id
            else warn(`${rowLabel}: unit of measure '${uomName}' not found, left unset`)
          }
          const purchaseUomName = str(r.purchaseUomName, 200)
          if (purchaseUomName) {
            const id = uomByName.get(normalizeNameKey(purchaseUomName))
            if (id) row.purchaseUomId = id
            else warn(`${rowLabel}: purchase UoM '${purchaseUomName}' not found, left unset`)
          }

          const saleUomsRaw = str(r.saleUoms, 5000)
          if (saleUomsRaw) {
            const { entries, malformed } = parseSaleUomsSummary(saleUomsRaw)
            for (const m of malformed) warn(`${rowLabel}: sellable unit segment '${m}' malformed, skipped`)
            const items: SaleUomItemInput[] = []
            for (const e of entries) {
              const uomId = uomByName.get(normalizeNameKey(e.uomName))
              if (!uomId) { warn(`${rowLabel}: sellable unit '${e.uomName}' not found, skipped`); continue }
              items.push({ uomId, factor: e.factor, spec: e.spec, sequence: e.sequence, grossWeight: e.grossWeight })
            }
            if (items.length > 0) row.saleUomItems = items
          }

          return row
        },

        async findMatchCandidates(keyValues) {
          const or: Array<Record<string, unknown>> = []
          if (keyValues.productNo?.length) or.push({ productNo: { in: keyValues.productNo } })
          if (keyValues.internalRef?.length) or.push({ internalRef: { in: keyValues.internalRef } })
          if (keyValues.barcode?.length) or.push({ barcode: { in: keyValues.barcode } })
          if (keyValues.externalId?.length) or.push({ externalId: { in: keyValues.externalId } })
          if (or.length === 0) return []
          // internalRef/barcode 在 schema 里都不是 @unique，同名可能有多条；按"最早创建的那条"
          // 兜底(orderBy createdAt asc)，与"更新已有商品"的直觉一致。productNo 本身是 @unique。
          const found = await prisma.product.findMany({ where: { OR: or }, orderBy: { createdAt: 'asc' } })
          for (const p of found) currentPrices.set(p.id, { listPrice: p.listPrice, standardPrice: p.standardPrice })
          return found as unknown as Array<Record<string, unknown> & { id: string }>
        },

        async findExistingNames() {
          const existing = await prisma.product.findMany({ select: { name: true } })
          return new Set(existing.map(p => p.name.toLowerCase()))
        },

        async writeRow(tx, row, existingId) {
          let productId: string
          let finalUomId: string | null
          let committedPrice: { name: string; listPrice: unknown; standardPrice: unknown } | undefined

          if (existingId) {
            // 只覆盖本行提供了非空值的字段——undefined 的字段完全不进 data，
            // 不会用 CREATE 才有意义的默认值(如 canBeSold=true)把已有数据冲掉。
            const updateData: Record<string, unknown> = { updatedBy: user.name || user.email }
            if (row.internalRef !== undefined) updateData.internalRef = row.internalRef
            if (row.barcode !== undefined) updateData.barcode = row.barcode
            if (row.externalId !== undefined) updateData.externalId = row.externalId
            updateData.name = row.name
            if (row.spec !== undefined) updateData.spec = row.spec
            if (row.description !== undefined) updateData.description = row.description
            if (row.saleDescription !== undefined) updateData.saleDescription = row.saleDescription
            if (row.categoryId !== undefined) updateData.categoryId = row.categoryId
            if (row.type !== undefined) updateData.type = row.type
            if (row.canBeSold !== undefined) updateData.canBeSold = row.canBeSold
            if (row.canBePurchased !== undefined) updateData.canBePurchased = row.canBePurchased
            if (row.listPrice !== undefined) updateData.listPrice = row.listPrice
            if (row.standardPrice !== undefined) updateData.standardPrice = row.standardPrice
            if (row.customerTaxRate !== undefined) updateData.customerTaxRate = row.customerTaxRate
            if (row.vendorTaxRate !== undefined) updateData.vendorTaxRate = row.vendorTaxRate
            if (row.commissionPrice !== undefined) updateData.commissionPrice = row.commissionPrice
            if (row.weight !== undefined) updateData.weight = row.weight
            if (row.netWeight !== undefined) updateData.netWeight = row.netWeight
            if (row.volume !== undefined) updateData.volume = row.volume
            if (row.qtyOnHand !== undefined) updateData.qtyOnHand = row.qtyOnHand
            if (row.uomId !== undefined) updateData.uomId = row.uomId
            if (row.purchaseUomId !== undefined) updateData.purchaseUomId = row.purchaseUomId
            if (row.tracking !== undefined) updateData.tracking = row.tracking
            if (row.status !== undefined) updateData.status = row.status

            const updatedProduct = await tx.product.update({
              where: { id: existingId },
              data: updateData as Parameters<typeof tx.product.update>[0]['data'],
            })
            productId = updatedProduct.id
            finalUomId = updatedProduct.uomId
            committedPrice = { name: updatedProduct.name, listPrice: updatedProduct.listPrice, standardPrice: updatedProduct.standardPrice }
          } else {
            const createData: Record<string, unknown> = {
              name: row.name,
              internalRef: row.internalRef ?? null,
              barcode: row.barcode ?? null,
              externalId: row.externalId ?? null,
              spec: row.spec ?? null,
              description: row.description ?? null,
              saleDescription: row.saleDescription ?? null,
              categoryId: row.categoryId,
              type: row.type ?? 'CONSU',
              canBeSold: row.canBeSold ?? true,
              canBePurchased: row.canBePurchased ?? true,
              listPrice: row.listPrice ?? 0,
              standardPrice: row.standardPrice ?? 0,
              customerTaxRate: row.customerTaxRate ?? 0,
              vendorTaxRate: row.vendorTaxRate ?? 0,
              commissionPrice: row.commissionPrice,
              weight: row.weight ?? null,
              netWeight: row.netWeight ?? null,
              volume: row.volume ?? null,
              qtyOnHand: row.qtyOnHand ?? 0,
              uomId: row.uomId,
              purchaseUomId: row.purchaseUomId,
              tracking: row.tracking ?? null,
              status: row.status ?? 'ACTIVE',
              updatedBy: user.name || user.email,
              createdBy: user.name || user.email,
            }
            const createdProduct = await tx.product.create({
              data: createData as Parameters<typeof tx.product.create>[0]['data'],
            })
            productId = createdProduct.id
            finalUomId = createdProduct.uomId
          }

          let saleUomWarning: string | undefined
          if (row.saleUomItems && row.saleUomItems.length > 0) {
            const { items: normalized, error } = normalizeAndValidateSaleUomItems(row.saleUomItems, finalUomId)
            if (error) {
              saleUomWarning = `${row.rowLabel}: sellable units config invalid (${error}), skipped`
            } else {
              await upsertProductSaleUomRows(tx, productId, finalUomId, normalized, user.name || user.email)
            }
          }
          return { id: productId, warning: saleUomWarning, data: committedPrice }
        },

        describeRowError,

        async onRowCommitted(row, existingId, outcome) {
          if (!existingId) return
          // 改价留痕(#22)：单条编辑页靠 diffChanges+writeLog 留痕，批量导入这里给每个
          // 真的改了价的商品单独补一条 before/after 记录，口径一致。
          // ⛔ 这里的 after 必须直接用 writeRow 里 tx.product.update() 自己的返回值(经由
          // outcome.data 透传)，不能在事务提交之后另外 findUnique 查一次——事务提交和这里
          // 之间有时间窗口，如果这期间有另一个请求也改了这条商品，重新查库拿到的就是那个
          // 并发请求写的值，会把这一行自己的改价算错(code review 发现)。
          const after = outcome.data
          if (!after) return
          const before = currentPrices.get(existingId)
          if (before) {
            const changes: Record<string, { before: unknown; after: unknown }> = {}
            if (JSON.stringify(before.listPrice) !== JSON.stringify(after.listPrice)) {
              changes.listPrice = { before: before.listPrice, after: after.listPrice }
            }
            if (JSON.stringify(before.standardPrice) !== JSON.stringify(after.standardPrice)) {
              changes.standardPrice = { before: before.standardPrice, after: after.standardPrice }
            }
            if (Object.keys(changes).length > 0) {
              await writeLog({
                userId: user.userId, userEmail: user.email, userName: user.name,
                action: 'UPDATE', resource: 'product', resourceId: outcome.id,
                detail: `批量导入更新商品价格: ${after.name}`,
                changes,
              })
            }
          }
          currentPrices.set(existingId, { listPrice: after.listPrice, standardPrice: after.standardPrice })
        },

        auditLog: { userId: user.userId, userEmail: user.email, userName: user.name, resource: 'product', resourceLabel: '商品' },
      })

      return NextResponse.json(result)
    } catch (error) {
      console.error('[POST /api/products/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
