import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { normalizeAndValidateSaleUomItems, upsertProductSaleUomRows } from '@/lib/product-sale-uom-upsert'
import type { SaleUomItemInput } from '@/lib/sale-uom'

/**
 * POST /api/products/bulk — 商品批量导入(CSV，20260930 重写，20261 补 productNo 匹配键)
 * ============================================================================
 * body: { rows: [{ name*, productNo?, internalRef?, barcode?, externalId?, spec?,
 *   description?, saleDescription?, category?, type?, canBeSold?, canBePurchased?,
 *   listPrice?, standardPrice?, customerTaxRate?, vendorTaxRate?, commissionPrice?,
 *   weight?, netWeight?, volume?, qtyOnHand?, uomName?, purchaseUomName?, tracking?,
 *   status?, saleUoms? }] }
 *
 * 与 lib/export/columns/product-templates.ts 导出的列一一对应(同一套人类可读的
 * category/uomName/purchaseUomName/saleUoms "UomName:factor:Y|N" 摘要格式)，
 * 导出 → Excel 改 → 重新导入这条路径两边共用同一份口径。
 *
 * 更新-或-创建匹配优先级：productNo → internalRef → barcode → externalId(仅精确匹配
 * 才触发更新)；都没匹配上时落回旧行为——按名字大小写不敏感判重，撞了就跳过(不覆盖)。
 * 更新时只覆盖本行提供了非空值的字段，不会用默认值把已有数据冲掉。
 *
 * productNo 是数据库自增主键，只用来"查找该更新哪一条"，绝不会被写进 create/update
 * 的 data 里——它本身是只读字段，这个端点永远不会去改它或生成它(见 Prisma schema
 * `@default(autoincrement())`)。客户端关心的"批量更新分类/价格会不会连带把商品的
 * ID 改掉"这个问题，答案是不会：这里走的是 Prisma `update`，商品的 cuid 主键(id)
 * 和 productNo 两者都不受这个接口影响，历史订单/采购/库存对该商品的引用不会断。
 *
 * 每行一个小事务、逐行提交，单行失败记进响应的 failed[] 带原因，不影响其它行(见写入循环注释)。
 * 文件总行数不设上限(20261002 客户要求取消 200 行限制)：导入弹窗(ProductImportDialog)
 * 自动按 100 行一批顺序提交，并通过 rowOffset 告诉这里本批第一行在整个文件里是第几行，
 * 提示信息里的 "Row N" 才对得上文件。MAX_ROWS_PER_REQUEST 只是单次请求的兜底上限，
 * 防止有人绕过弹窗一次塞几万行把请求拖过 nginx 120s 的 proxy_read_timeout。
 */

const MAX_ROWS_PER_REQUEST = 500
/** 单行事务的超时。Prisma 默认 5 秒；数据库在 Neon 上时每条查询都是网络往返，
 *  一行最多也就十来条查询，给足余量，免得网络抖一下就整行失败。 */
const ROW_TX_TIMEOUT_MS = 15_000

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

/**
 * 单行写入失败的原因，给客户看的一句话。Product 上客户能写的唯一约束字段只有 externalId
 * (导入文件的 "ID" 列；productNo/id 由数据库生成，导入从不写)，所以撞唯一约束就是 ID 被别的
 * 商品占用了。识别同时兼容 Prisma 原生错误码与 driver adapter 包装后的形态(同 lib/invoice-number.ts)。
 */
function describeRowError(e: unknown, row: { externalId?: string }): string {
  const code = (e as { code?: string } | null)?.code
  const msg = e instanceof Error ? e.message : String(e)
  if (code === 'P2002' || code === '23505' || /Unique constraint|UniqueConstraintViolation|duplicate key value/i.test(msg)) {
    return row.externalId
      ? `ID '${row.externalId}' is already used by another product, row not imported`
      : 'a unique field is already used by another product, row not imported'
  }
  if (code === 'P2028' || /Transaction API error|expired transaction|Transaction already closed|timed out/i.test(msg)) {
    return 'database timed out, row not imported — please re-import this row'
  }
  // Prisma 的报错是多行的("Invalid `prisma.x.y()` invocation: ... <真正原因>")，最后一行才是原因
  const lastLine = msg.split('\n').map(l => l.trim()).filter(Boolean).pop()
  return (lastLine ?? 'unknown error').slice(0, 200)
}

interface SaleUomEntry { uomName: string; factor: number; spec?: string; sequence?: number; grossWeight?: number }

/**
 * 解析导出侧 "UomName:factor:Y|N[:spec[:sequence[:grossWeight]]]" 摘要格式(分号分隔，
 * 与 lib/export/loaders/product-templates.ts 的 saleUomsSummary 逐字对应)。
 * 前 3 段(单位名/系数/是否默认)必填，spec/装货顺序/毛重 3 段可选、可省略、可留空——
 * 20261001 客户反馈"产品规格/装货顺序/毛重这几个字段怎么批量导入"，在原有 3 段格式后面
 * 顺延加 3 个可选段，旧的 3 段格式(没有这 3 个字段的历史导出文件)原样兼容，不用重新导出。
 * 第 3 段(Y|N，是否默认单位)本身不参与解析——默认单位由下面 normalizeAndValidateSaleUomItems
 * 按 product.uomId 匹配派生，Y|N 只是给人看的标注，跟原有行为一致。
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
  /** 匹配-更新用的最高优先级键(数据库自动生成，只读，永不写回)——见下方匹配优先级注释 */
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
      // 本批第一行在整个文件里的序号偏移(导入弹窗分批提交时传)，提示里的 "Row N" 按整个文件计数
      const rowOffset = Number.isInteger(data.rowOffset) && data.rowOffset >= 0 ? data.rowOffset as number : 0

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
        const rowNo = rowOffset + i + 1
        const name = str(r.name, 200)
        if (!name) {
          warnings.push(`Row ${rowNo}: missing required 'name', skipped`)
          return
        }
        const rowLabel = `Row ${rowNo} (${name})`
        const row: ResolvedRow = { rowLabel, name }

        // Product No. 是自增主键(见 prisma/schema.prisma Product.productNo)，只读——
        // 这里只用它做匹配-更新的查找键，绝不会被写进 create/update 的 data 里。
        // 非法值(非整数/负数)当成"没填"处理，落回按 internalRef/barcode/externalId 匹配。
        const productNoRaw = num(r.productNo)
        if (productNoRaw !== undefined) {
          if (Number.isInteger(productNoRaw) && productNoRaw > 0) row.productNo = productNoRaw
          else warnings.push(`${rowLabel}: Product No. '${r.productNo}' is not a valid positive integer, ignored`)
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
            items.push({ uomId, factor: e.factor, spec: e.spec, sequence: e.sequence, grossWeight: e.grossWeight })
          }
          if (items.length > 0) row.saleUomItems = items
        }

        resolvedRows.push(row)
      })

      // 本批没有一行带 name：照常返回(每行的原因已在 warnings 里)，不报 400——
      // 弹窗是分批提交的，一批全是空名行不该把后面几批也一起拦掉。
      if (resolvedRows.length === 0) {
        return NextResponse.json({ created: 0, updated: 0, skipped: [], failed: [], warnings })
      }

      // ── 匹配已有商品：productNo → internalRef → barcode → externalId，优先级顺序，仅精确匹配 ──
      // productNo 排第一优先级：它是数据库自增主键，每个商品必有、永不改变，且天然就在
      // 商品导出文件的第一列——客户初始化建库时很多商品的 internalRef/barcode 本来就是空的，
      // 只靠那两个字段做"导出→改价改分类→重新导入"匹配不上，会被当"撞名跳过"，改的东西
      // 静默丢失。productNo 不依赖历史数据是否填过编号，保证批量更新对整个商品库都可靠。
      const productNos = [...new Set(resolvedRows.map(r => r.productNo).filter((v): v is number => v !== undefined))]
      const internalRefs = [...new Set(resolvedRows.map(r => r.internalRef).filter((v): v is string => !!v))]
      const barcodes = [...new Set(resolvedRows.map(r => r.barcode).filter((v): v is string => !!v))]
      const externalIds = [...new Set(resolvedRows.map(r => r.externalId).filter((v): v is string => !!v))]

      const keyOrConditions: Array<Record<string, unknown>> = []
      if (productNos.length) keyOrConditions.push({ productNo: { in: productNos } })
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
      // productNo 本身是 @unique，不存在这个问题。
      const byProductNo = new Map<number, (typeof matchCandidates)[number]>()
      const byInternalRef = new Map<string, (typeof matchCandidates)[number]>()
      const byBarcode = new Map<string, (typeof matchCandidates)[number]>()
      const byExternalId = new Map<string, (typeof matchCandidates)[number]>()
      for (const p of matchCandidates) {
        byProductNo.set(p.productNo, p)
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
        if (row.productNo !== undefined) {
          existingId = byProductNo.get(row.productNo)?.id ?? null
          if (!existingId) warnings.push(`${row.rowLabel}: Product No. ${row.productNo} not found, falling back to other match keys`)
        }
        if (!existingId && row.internalRef) existingId = byInternalRef.get(row.internalRef)?.id ?? null
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
      const failed: string[] = []
      const updatedBy = user.name || user.email

      // 价格变更留痕(#22)用的"改前价"：直接取上面匹配时已经整行查出来的商品，不再额外查库。
      // 每成功更新一行就刷新一次——同一份文件里两行改同一个商品时，第二行的"改前"才是第一行改完的值。
      const currentPrices = new Map<string, { listPrice: unknown; standardPrice: unknown }>()
      for (const p of matchCandidates) currentPrices.set(p.id, { listPrice: p.listPrice, standardPrice: p.standardPrice })

      // 逐行提交，每行一个小事务(20261002 客户反馈：199 行导入报 "Server temporarily unavailable")。
      // 之前是每 50 行一个交互式事务：50 × (更新商品 + 删可售单位 + 每个单位一次 upsert) ≈ 250 条
      // 串行查询，数据库在 Neon 上每条都是一次网络往返，轻松顶破 Prisma 交互式事务默认的 5 秒上限
      // (P2028，lib/invoice-number.ts 踩过同一个坑)；另外任意一行撞了 externalId 唯一约束(P2002)
      // 也会把同批 49 行一起回滚。两种情况都被最外层 catch 吞成笼统的 500，前面几批却已经提交了，
      // 客户只看到"服务器暂时不可用"，不知道哪些进去了、哪些没进去。
      // 现在一行一个事务(商品本身 + 它的可售单位要么一起成功要么一起回滚)，单行失败只记进 failed
      // 带上具体原因，其余行照常导入。计数和改价日志都只在该行事务真正提交之后才记。
      for (const { row, existingId } of planned) {
        try {
          const outcome = await prisma.$transaction(async (tx) => {
            let productId: string
            let finalUomId: string | null
            let product: { name: string; listPrice: unknown; standardPrice: unknown }

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

              const updatedProduct = await tx.product.update({
                where: { id: existingId },
                data: updateData as Parameters<typeof tx.product.update>[0]['data'],
              })
              productId = updatedProduct.id
              finalUomId = updatedProduct.uomId
              product = updatedProduct
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
              const createdProduct = await tx.product.create({
                data: createData as Parameters<typeof tx.product.create>[0]['data'],
              })
              productId = createdProduct.id
              finalUomId = createdProduct.uomId
              product = createdProduct
            }

            let saleUomWarning: string | null = null
            if (row.saleUomItems && row.saleUomItems.length > 0) {
              const { items: normalized, error } = normalizeAndValidateSaleUomItems(row.saleUomItems, finalUomId)
              if (error) {
                saleUomWarning = `${row.rowLabel}: sellable units config invalid (${error}), skipped`
              } else {
                await upsertProductSaleUomRows(tx, productId, finalUomId, normalized, updatedBy)
              }
            }
            return { productId, product, saleUomWarning }
          }, { timeout: ROW_TX_TIMEOUT_MS })

          if (outcome.saleUomWarning) warnings.push(outcome.saleUomWarning)

          if (!existingId) {
            created++
            continue
          }
          updated++

          // 改价留痕(#22)：单条编辑页 PUT /api/products/[id] 靠 diffChanges+writeLog 留痕，
          // 批量导入这里给每个真的改了价的商品单独补一条 before/after 记录，口径一致。
          // 放在事务提交之后写——writeLog 用的是顶层 prisma，不在事务里，提前写的话事务回滚时
          // 会留下一条"改价了"的假记录。
          const after = { listPrice: outcome.product.listPrice, standardPrice: outcome.product.standardPrice }
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
                action: 'UPDATE', resource: 'product', resourceId: outcome.productId,
                detail: `批量导入更新商品价格: ${outcome.product.name}`,
                changes,
              })
            }
          }
          currentPrices.set(existingId, after)
        } catch (e) {
          console.error(`[POST /api/products/bulk] ${row.rowLabel}`, e)
          failed.push(`${row.rowLabel}: ${describeRowError(e, row)}`)
        }
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'product', resourceId: 'bulk',
        detail: `批量导入商品：新建 ${created}，更新 ${updated}，重名跳过 ${skipped.length}，失败 ${failed.length}`,
      })

      return NextResponse.json({ created, updated, skipped, failed, warnings })
    } catch (error) {
      console.error('[POST /api/products/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
