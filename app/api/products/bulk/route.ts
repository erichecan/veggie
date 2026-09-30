import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { normalizeAndValidateSaleUomItems, upsertProductSaleUomRows } from '@/lib/product-sale-uom-upsert'
import type { SaleUomItemInput } from '@/lib/sale-uom'

/**
 * POST /api/products/bulk — 商品批量导入(CSV，20260930 重写)
 * ============================================================================
 * body: { rows: [{ name*, internalRef?, barcode?, externalId?, spec?, description?,
 *   saleDescription?, category?, type?, canBeSold?, canBePurchased?, listPrice?,
 *   standardPrice?, customerTaxRate?, vendorTaxRate?, commissionPrice?, weight?,
 *   netWeight?, volume?, qtyOnHand?, uomName?, purchaseUomName?, tracking?, status?,
 *   saleUoms? }] }
 *
 * 与 lib/export/columns/product-templates.ts 导出的列一一对应(同一套人类可读的
 * category/uomName/purchaseUomName/saleUoms "UomName:factor:Y|N" 摘要格式)，
 * 导出 → Excel 改 → 重新导入这条路径两边共用同一份口径。
 *
 * 更新-或-创建匹配优先级：internalRef → barcode → externalId(仅精确匹配才触发更新)；
 * 都没匹配上时落回旧行为——按名字大小写不敏感判重，撞了就跳过(不覆盖)。
 * 更新时只覆盖本行提供了非空值的字段，不会用默认值把已有数据冲掉。
 *
 * 一次最多 200 行，每 50 行一个事务，与旧实现一致。
 */

const MAX_ROWS = 200
const CHUNK_SIZE = 50

type ProductTypeValue = 'PRODUCT' | 'CONSU' | 'SERVICE'
type ProductStatusValue = 'DRAFT' | 'ACTIVE' | 'ARCHIVED'

const TYPE_VALUES: Record<string, ProductTypeValue> = { product: 'PRODUCT', consu: 'CONSU', service: 'SERVICE' }
const STATUS_VALUES: Record<string, ProductStatusValue> = { draft: 'DRAFT', active: 'ACTIVE', archived: 'ARCHIVED' }

function str(v: unknown, maxLen = 200): string | undefined {
  if (v === null || v === undefined) return undefined
  const s = String(v).trim()
  return s.length > 0 ? s.slice(0, maxLen) : undefined
}

function num(v: unknown): number | undefined {
  if (v === null || v === undefined || v === '') return undefined
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 有上下限的数值字段：超界当成"没填"处理，但要留痕迹(调用方负责推 warning)。 */
function boundedNum(v: unknown, min: number, max: number): { value: number | undefined; invalid: boolean } {
  const n = num(v)
  if (n === undefined) return { value: undefined, invalid: false }
  if (n < min || n > max) return { value: undefined, invalid: true }
  return { value: n, invalid: false }
}

function bool(v: unknown): { value: boolean | undefined; invalid: boolean } {
  if (v === null || v === undefined || v === '') return { value: undefined, invalid: false }
  const s = String(v).trim().toLowerCase()
  if (['1', 'true', 'y', 'yes', '是'].includes(s)) return { value: true, invalid: false }
  if (['0', 'false', 'n', 'no', '否'].includes(s)) return { value: false, invalid: false }
  return { value: undefined, invalid: true }
}

function normKey(s: string): string {
  return s.trim().toLowerCase()
}

interface SaleUomEntry { uomName: string; factor: number }

/**
 * 解析导出侧 "UomName:factor:Y|N" 摘要格式(分号分隔，与
 * lib/export/loaders/product-templates.ts 的 saleUomsSummary 逐字对应)。
 * 坏段落只跳过那一段，不让整行导入失败。
 */
function parseSaleUomsSummary(raw: string): { entries: SaleUomEntry[]; malformed: string[] } {
  const entries: SaleUomEntry[] = []
  const malformed: string[] = []
  for (const part of raw.split(';')) {
    const seg = part.trim()
    if (!seg) continue
    const bits = seg.split(':')
    if (bits.length !== 3) { malformed.push(seg); continue }
    const name = bits[0].trim()
    const factor = Number(bits[1].trim())
    if (!name || !Number.isFinite(factor) || factor <= 0) { malformed.push(seg); continue }
    entries.push({ uomName: name, factor })
  }
  return { entries, malformed }
}

interface ResolvedRow {
  rowLabel: string
  name: string
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
      if (rawRows.length > MAX_ROWS) return NextResponse.json({ error: `一次最多导入 ${MAX_ROWS} 行` }, { status: 400 })

      const warnings: string[] = []

      // ── 预取匹配用的字典：分类 / 单位(中英文名均可命中，大小写不敏感) ──────────
      const [categories, uoms] = await Promise.all([
        prisma.productCategory.findMany({ select: { id: true, name: true, nameZh: true } }),
        prisma.uom.findMany({ select: { id: true, name: true, nameZh: true } }),
      ])
      const categoryByName = new Map<string, string>()
      for (const c of categories) {
        if (c.name) categoryByName.set(normKey(c.name), c.id)
        if (c.nameZh) categoryByName.set(normKey(c.nameZh), c.id)
      }
      const uomByName = new Map<string, string>()
      for (const u of uoms) {
        if (u.name) uomByName.set(normKey(u.name), u.id)
        if (u.nameZh) uomByName.set(normKey(u.nameZh), u.id)
      }

      // ── 逐行解析 + 归一化(纯内存，不碰数据库) ────────────────────────────
      const resolvedRows: ResolvedRow[] = []
      rawRows.forEach((r: Record<string, unknown>, i: number) => {
        const name = str(r.name, 200)
        if (!name) {
          warnings.push(`Row ${i + 1}: missing required 'name', skipped`)
          return
        }
        const rowLabel = `Row ${i + 1} (${name})`
        const row: ResolvedRow = { rowLabel, name }

        row.internalRef = str(r.internalRef, 100)
        row.barcode = str(r.barcode, 100)
        row.externalId = str(r.externalId, 100)
        row.spec = str(r.spec, 200)
        row.description = str(r.description, 5000)
        row.saleDescription = str(r.saleDescription, 5000)
        row.tracking = str(r.tracking, 50)

        const categoryName = str(r.category, 200)
        if (categoryName) {
          const id = categoryByName.get(normKey(categoryName))
          if (id) row.categoryId = id
          else warnings.push(`${rowLabel}: category '${categoryName}' not found, left unset`)
        }

        const typeRaw = str(r.type, 20)?.toLowerCase()
        if (typeRaw) {
          const mapped = TYPE_VALUES[typeRaw]
          if (mapped) row.type = mapped
          else warnings.push(`${rowLabel}: type '${typeRaw}' not recognized, ignored`)
        }

        const statusRaw = str(r.status, 20)?.toLowerCase()
        if (statusRaw) {
          const mapped = STATUS_VALUES[statusRaw]
          if (mapped) row.status = mapped
          else warnings.push(`${rowLabel}: status '${statusRaw}' not recognized, ignored`)
        }

        const canBeSold = bool(r.canBeSold)
        if (canBeSold.invalid) warnings.push(`${rowLabel}: canBeSold value not recognized, ignored`)
        row.canBeSold = canBeSold.value

        const canBePurchased = bool(r.canBePurchased)
        if (canBePurchased.invalid) warnings.push(`${rowLabel}: canBePurchased value not recognized, ignored`)
        row.canBePurchased = canBePurchased.value

        const listPrice = boundedNum(r.listPrice, 0, 1_000_000)
        if (listPrice.invalid) warnings.push(`${rowLabel}: listPrice out of range (0-1,000,000), ignored`)
        row.listPrice = listPrice.value

        // ⛔ 老 bulk-import 从不设置 standardPrice，商品落库成 null，商品详情页曾
        // 对 null.toFixed() 崩溃(该处已防御性修复，但导入这里仍须给出合理默认值 0，
        // 这是数据质量问题，不只是崩溃问题)。
        const standardPrice = boundedNum(r.standardPrice, 0, 1_000_000)
        if (standardPrice.invalid) warnings.push(`${rowLabel}: standardPrice out of range (0-1,000,000), ignored`)
        row.standardPrice = standardPrice.value

        // customerTaxRate/vendorTaxRate 与库里/导出口径一致，存的是小数(0.135=13.5%)，
        // 不是百分数——导出时 taxPercent() 乘了 100，客户端解析 CSV 时应先除回来再传上来。
        const customerTaxRate = boundedNum(r.customerTaxRate, 0, 1)
        if (customerTaxRate.invalid) warnings.push(`${rowLabel}: customerTaxRate out of range (0-1), ignored`)
        row.customerTaxRate = customerTaxRate.value

        const vendorTaxRate = boundedNum(r.vendorTaxRate, 0, 1)
        if (vendorTaxRate.invalid) warnings.push(`${rowLabel}: vendorTaxRate out of range (0-1), ignored`)
        row.vendorTaxRate = vendorTaxRate.value

        row.commissionPrice = num(r.commissionPrice)
        row.weight = num(r.weight)
        row.netWeight = num(r.netWeight)
        row.volume = num(r.volume)
        row.qtyOnHand = num(r.qtyOnHand)

        const uomName = str(r.uomName, 200)
        if (uomName) {
          const id = uomByName.get(normKey(uomName))
          if (id) row.uomId = id
          else warnings.push(`${rowLabel}: unit of measure '${uomName}' not found, left unset`)
        }
        const purchaseUomName = str(r.purchaseUomName, 200)
        if (purchaseUomName) {
          const id = uomByName.get(normKey(purchaseUomName))
          if (id) row.purchaseUomId = id
          else warnings.push(`${rowLabel}: purchase UoM '${purchaseUomName}' not found, left unset`)
        }

        const saleUomsRaw = str(r.saleUoms, 5000)
        if (saleUomsRaw) {
          const { entries, malformed } = parseSaleUomsSummary(saleUomsRaw)
          for (const m of malformed) warnings.push(`${rowLabel}: sellable unit segment '${m}' malformed, skipped`)
          const items: SaleUomItemInput[] = []
          for (const e of entries) {
            const uomId = uomByName.get(normKey(e.uomName))
            if (!uomId) { warnings.push(`${rowLabel}: sellable unit '${e.uomName}' not found, skipped`); continue }
            items.push({ uomId, factor: e.factor })
          }
          if (items.length > 0) row.saleUomItems = items
        }

        resolvedRows.push(row)
      })

      if (resolvedRows.length === 0) {
        return NextResponse.json({ error: '没有有效行(name 必填)' }, { status: 400 })
      }

      // ── 匹配已有商品：internalRef → barcode → externalId，优先级顺序，仅精确匹配 ──
      const internalRefs = [...new Set(resolvedRows.map(r => r.internalRef).filter((v): v is string => !!v))]
      const barcodes = [...new Set(resolvedRows.map(r => r.barcode).filter((v): v is string => !!v))]
      const externalIds = [...new Set(resolvedRows.map(r => r.externalId).filter((v): v is string => !!v))]

      const keyOrConditions: Array<Record<string, unknown>> = []
      if (internalRefs.length) keyOrConditions.push({ internalRef: { in: internalRefs } })
      if (barcodes.length) keyOrConditions.push({ barcode: { in: barcodes } })
      if (externalIds.length) keyOrConditions.push({ externalId: { in: externalIds } })

      const matchCandidates = keyOrConditions.length
        ? await prisma.product.findMany({
            where: { OR: keyOrConditions } as NonNullable<Parameters<typeof prisma.product.findMany>[0]>['where'],
            orderBy: { createdAt: 'asc' },
          })
        : []

      // internalRef/barcode 在 schema 里都不是 @unique，同名可能有多条；这里按"最早创建的那条"
      // 兜底(orderBy createdAt asc)，与"更新已有商品"的直觉一致，不做更复杂的歧义判断。
      const byInternalRef = new Map<string, (typeof matchCandidates)[number]>()
      const byBarcode = new Map<string, (typeof matchCandidates)[number]>()
      const byExternalId = new Map<string, (typeof matchCandidates)[number]>()
      for (const p of matchCandidates) {
        if (p.internalRef && !byInternalRef.has(p.internalRef)) byInternalRef.set(p.internalRef, p)
        if (p.barcode && !byBarcode.has(p.barcode)) byBarcode.set(p.barcode, p)
        if (p.externalId && !byExternalId.has(p.externalId)) byExternalId.set(p.externalId, p)
      }

      // ── 没被 key 命中的行，落回旧的按 name 大小写不敏感判重(安全行为，保留) ──────
      const existingNames = await prisma.product.findMany({ select: { name: true } })
      const takenNames = new Set(existingNames.map(p => p.name.toLowerCase()))

      const skipped: string[] = []
      interface PlannedRow { row: ResolvedRow; existingId: string | null }
      const planned: PlannedRow[] = []
      for (const row of resolvedRows) {
        let existingId: string | null = null
        if (row.internalRef) existingId = byInternalRef.get(row.internalRef)?.id ?? null
        if (!existingId && row.barcode) existingId = byBarcode.get(row.barcode)?.id ?? null
        if (!existingId && row.externalId) existingId = byExternalId.get(row.externalId)?.id ?? null

        if (!existingId) {
          const key = row.name.toLowerCase()
          if (takenNames.has(key)) { skipped.push(row.name); continue }
          takenNames.add(key)
        }
        planned.push({ row, existingId })
      }

      let created = 0
      let updated = 0
      const updatedBy = user.name || user.email

      // 分批事务：每批 50 行，与旧实现一致
      for (let i = 0; i < planned.length; i += CHUNK_SIZE) {
        const chunk = planned.slice(i, i + CHUNK_SIZE)
        await prisma.$transaction(async (tx) => {
          for (const { row, existingId } of chunk) {
            let productId: string
            let finalUomId: string | null

            if (existingId) {
              // 只覆盖本行提供了非空值的字段——undefined 的字段完全不进 data，
              // 不会用 CREATE 才有意义的默认值(如 canBeSold=true)把已有数据冲掉。
              const updateData: Record<string, unknown> = { updatedBy }
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

              const product = await tx.product.update({
                where: { id: existingId },
                data: updateData as Parameters<typeof tx.product.update>[0]['data'],
              })
              productId = product.id
              finalUomId = product.uomId
              updated++
            } else {
              // CREATE 才应用默认值(canBeSold/canBePurchased=true, type=CONSU,
              // status=ACTIVE, standardPrice/listPrice/customerTaxRate/vendorTaxRate/
              // qtyOnHand=0)——commissionPrice 保持可空语义，不臆造成 0。
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
                updatedBy,
                createdBy: updatedBy,
              }
              const product = await tx.product.create({
                data: createData as Parameters<typeof tx.product.create>[0]['data'],
              })
              productId = product.id
              finalUomId = product.uomId
              created++
            }

            if (row.saleUomItems && row.saleUomItems.length > 0) {
              const { items: normalized, error } = normalizeAndValidateSaleUomItems(row.saleUomItems, finalUomId)
              if (error) {
                warnings.push(`${row.rowLabel}: sellable units config invalid (${error}), skipped`)
              } else {
                await upsertProductSaleUomRows(tx, productId, finalUomId, normalized, updatedBy)
              }
            }
          }
        })
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product', resourceId: 'bulk',
        detail: `批量导入商品：新建 ${created}，更新 ${updated}，重名跳过 ${skipped.length}`,
      })

      return NextResponse.json({ created, updated, skipped, warnings })
    } catch (error) {
      console.error('[POST /api/products/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
