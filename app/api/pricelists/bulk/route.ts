import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import {
  str, num, bool, isUniqueConstraintError, isTransactionTimeoutError, lastErrorLine, normalizeNameKey,
} from '@/lib/import/bulk-import-engine'
import { validateAndNormalizeItem, type PricelistItemInput } from '@/lib/pricelist-item'

/**
 * POST /api/pricelists/bulk — 价格表批量导入(CSV，20261003 补齐，此前"导入"是假按钮)
 * ============================================================================
 * 跟商品/客户/供应商/单位/产品分类那几个 bulk 端点不一样，**不走** lib/import/bulk-import-
 * engine.ts 那套引擎——那套假设"一行 = 一条独立记录"，价格表是"多行共享同一个父记录"
 * (一行 = 一条定价规则，同一个价格表的规则分布在很多行里，靠「价格表名称/ID」这一列分组)，
 * 引擎按批量预取 + 行内判重的设计在这里会把"同一批里两行要建同一个新价格表"误判成撞名
 * 跳过，所以这里是独立实现：逐行处理，每行自己去查/建父记录，而不是预先批量查一次。
 *
 * body: { rows: [{
 *   externalId?, pricelistName*, currency?, active?, selectable?, pricelistSequence?,
 *   itemId?, applyOn?, category?, product?, minQty?, dateStart?, dateEnd?, computeType?,
 *   fixedPrice?, percentDiscount?, formulaBase?, basedOnPricelist?, priceDiscount?,
 *   priceSurcharge?, priceMinMargin?, priceMaxMargin?, roundingMethod?, itemSequence?,
 *   uom?, badgeLabel?
 * }], rowOffset? }
 *
 * 匹配：价格表按 externalId(精确) → 名称(大小写不敏感) 找已有的；都没找到就新建。
 * applyOn 留空 = 这一行只改价格表本身的设置(名称/币种/启用/可选/排序)，不带规则。
 * itemId 留空 = 新增一条规则(追加到 items 数组末尾)；itemId 命中已有规则 = 原地替换那一条。
 * ⛔ 不支持删除已有规则——CSV 只会新增/更新规则，误操作不会把价格表的定价规则清空。
 */

const MAX_ROWS_PER_REQUEST = 500

interface ResolvedRow {
  rowLabel: string
  externalId?: string
  pricelistName: string
  currency?: string
  active?: boolean
  selectable?: boolean
  pricelistSequence?: number
  itemId?: string
  hasItem: boolean
  /** basedOnPricelist 留着原始名字，不在这里解析——见下方"basedOnPricelist 的坑"说明 */
  itemInput?: Omit<PricelistItemInput, 'basedOnPricelistId'> & { basedOnPricelistName?: string }
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

      const [categories, uoms] = await Promise.all([
        prisma.productCategory.findMany({ select: { id: true, name: true, nameZh: true } }),
        prisma.uom.findMany({ select: { id: true, name: true, nameZh: true } }),
      ])
      const categoryByName = new Map<string, string>()
      for (const c of categories) { categoryByName.set(normalizeNameKey(c.name), c.id); if (c.nameZh) categoryByName.set(normalizeNameKey(c.nameZh), c.id) }
      const uomByName = new Map<string, string>()
      for (const u of uoms) { uomByName.set(normalizeNameKey(u.name), u.id); if (u.nameZh) uomByName.set(normalizeNameKey(u.nameZh), u.id) }

      // 商品名→id 一次性批量查(只查 CSV 里实际出现过的那些名字)，不逐行各查一次——
      // 价格表跟分类/单位不一样，商品动辄几千条，不值得像上面那样整表拉下来，
      // 但逐行查又会在几百行的文件上打出几百次 Neon 网络往返(code review 发现)。
      const referencedProductNames = new Set<string>()
      for (const r of rawRows as Record<string, unknown>[]) {
        const p = str(r.product, 200)
        if (p) referencedProductNames.add(p)
      }
      const productIdByName = new Map<string, string>()
      if (referencedProductNames.size > 0) {
        const matches = await prisma.product.findMany({
          where: { OR: [...referencedProductNames].map(name => ({ name: { equals: name, mode: 'insensitive' as const } })) },
          orderBy: { createdAt: 'asc' },
          select: { id: true, name: true },
        })
        for (const p of matches) {
          const key = normalizeNameKey(p.name)
          if (!productIdByName.has(key)) productIdByName.set(key, p.id) // 同名多条，保留最早创建的那条
        }
      }

      // basedOnPricelist(规则引用"另一个价格表"做公式基准) 的坑：这个名字可能指向
      // 本批文件里稍后才会新建的价格表，所以**不能**在下面这个解析阶段就查库——那时候
      // 别的行还一行都没写入，查了也是查不到(实测复现：A 行新建"Base 10%"，B 行的规则
      // basedOnPricelist 填"Base 10%"，如果在这里提前查，B 永远查不到 A 马上要建的那个)。
      // 真正的解析挪到下面写入循环里、那一行自己的事务内部做，那时候前面的行已经真正
      // commit 过了，才查得到。这里只缓存"查到过的"结果(不缓存查不到)，避免同一个名字
      // 在后面某一行终于建出来之后，还被早前的 null 缓存挡住。
      const pricelistIdByName = new Map<string, string>()
      async function resolvePricelistId(name: string): Promise<string | undefined> {
        const key = normalizeNameKey(name)
        const cached = pricelistIdByName.get(key)
        if (cached) return cached
        const found = await prisma.odooPricelist.findFirst({ where: { name: { equals: name, mode: 'insensitive' } }, select: { id: true } })
        if (found) pricelistIdByName.set(key, found.id)
        return found?.id
      }

      const warnings: string[] = []
      const resolvedRows: ResolvedRow[] = []
      rawRows.forEach((raw: Record<string, unknown>, i: number) => {
        const r = raw
        const rowNo = rowOffset + i + 1
        const pricelistName = str(r.pricelistName, 200)
        if (!pricelistName) { warnings.push(`Row ${rowNo}: missing required 'pricelistName', skipped`); return }
        const rowLabel = `Row ${rowNo} (${pricelistName})`
        const row: ResolvedRow = { rowLabel, pricelistName, hasItem: false }
        row.externalId = str(r.externalId, 100)
        row.currency = str(r.currency, 10)
        const active = bool(r.active)
        if (active.invalid) warnings.push(`${rowLabel}: active value not recognized, ignored`)
        row.active = active.value
        const selectable = bool(r.selectable)
        if (selectable.invalid) warnings.push(`${rowLabel}: selectable value not recognized, ignored`)
        row.selectable = selectable.value
        row.pricelistSequence = num(r.pricelistSequence)

        const applyOnRaw = str(r.applyOn, 20)
        if (applyOnRaw) {
          row.hasItem = true
          row.itemId = str(r.itemId, 100)

          let categoryId: string | undefined
          const categoryNameRaw = str(r.category, 200)
          if (categoryNameRaw) {
            categoryId = categoryByName.get(normalizeNameKey(categoryNameRaw))
            if (!categoryId) warnings.push(`${rowLabel}: category '${categoryNameRaw}' not found, left unset`)
          }
          let productId: string | undefined
          const productNameRaw = str(r.product, 200)
          if (productNameRaw) {
            productId = productIdByName.get(normalizeNameKey(productNameRaw))
            if (!productId) warnings.push(`${rowLabel}: product '${productNameRaw}' not found, left unset`)
          }
          let uomId: string | undefined
          const uomNameRaw = str(r.uom, 200)
          if (uomNameRaw) {
            uomId = uomByName.get(normalizeNameKey(uomNameRaw))
            if (!uomId) warnings.push(`${rowLabel}: unit '${uomNameRaw}' not found, left unset`)
          }

          const applyOn = applyOnRaw.toLowerCase()
          row.itemInput = {
            id: row.itemId || undefined,
            applyOn,
            productTemplateId: applyOn === 'product' ? productId : undefined,
            productVariantId: applyOn === 'variant' ? productId : undefined,
            categoryId: applyOn === 'category' ? categoryId : undefined,
            minQty: num(r.minQty) ?? 0,
            dateStart: str(r.dateStart, 20),
            dateEnd: str(r.dateEnd, 20),
            computeType: str(r.computeType, 20)?.toLowerCase() ?? 'formula',
            fixedPrice: num(r.fixedPrice),
            percentDiscount: num(r.percentDiscount),
            formulaBase: str(r.formulaBase, 20)?.toLowerCase(),
            basedOnPricelistName: str(r.basedOnPricelist, 200),
            priceDiscount: num(r.priceDiscount),
            priceSurcharge: num(r.priceSurcharge),
            priceMinMargin: num(r.priceMinMargin),
            priceMaxMargin: num(r.priceMaxMargin),
            roundingMethod: num(r.roundingMethod),
            sequence: num(r.itemSequence),
            uomId,
            badgeLabel: str(r.badgeLabel, 200),
          }
        }
        resolvedRows.push(row)
      })

      let created = 0
      let updated = 0
      const failed: string[] = []

      for (const row of resolvedRows) {
        try {
          const outcome = await prisma.$transaction(async (tx) => {
            let pricelistId = row.externalId
              ? (await tx.odooPricelist.findUnique({ where: { externalId: row.externalId }, select: { id: true } }))?.id
              : undefined
            if (!pricelistId) {
              pricelistId = pricelistIdByName.get(normalizeNameKey(row.pricelistName))
                ?? (await tx.odooPricelist.findFirst({ where: { name: { equals: row.pricelistName, mode: 'insensitive' } }, select: { id: true } }))?.id
            }

            let isNewPricelist = false
            if (pricelistId) {
              const settingsUpdate: Record<string, unknown> = { name: row.pricelistName }
              if (row.externalId !== undefined) settingsUpdate.externalId = row.externalId
              if (row.currency !== undefined) settingsUpdate.currency = row.currency
              if (row.active !== undefined) settingsUpdate.active = row.active
              if (row.selectable !== undefined) settingsUpdate.selectable = row.selectable
              if (row.pricelistSequence !== undefined) settingsUpdate.sequence = row.pricelistSequence
              await tx.odooPricelist.update({ where: { id: pricelistId }, data: settingsUpdate })
            } else {
              const createdPricelist = await tx.odooPricelist.create({
                data: {
                  name: row.pricelistName,
                  externalId: row.externalId ?? null,
                  currency: row.currency ?? 'EUR',
                  active: row.active ?? true,
                  selectable: row.selectable ?? true,
                  sequence: row.pricelistSequence ?? 10,
                  items: [],
                },
              })
              pricelistId = createdPricelist.id
              isNewPricelist = true
            }
            pricelistIdByName.set(normalizeNameKey(row.pricelistName), pricelistId)

            let itemWarning: string | undefined
            if (row.hasItem && row.itemInput) {
              // basedOnPricelist 在这里(写入时、这一行自己的事务里)才解析——见上方"坑"的说明，
              // 此时前面的行都已经真正 commit 过了，能查到同一批里刚建出来的价格表。
              let basedOnPricelistId: string | undefined
              if (row.itemInput.basedOnPricelistName) {
                basedOnPricelistId = await resolvePricelistId(row.itemInput.basedOnPricelistName)
                if (!basedOnPricelistId) warnings.push(`${row.rowLabel}: basedOnPricelist '${row.itemInput.basedOnPricelistName}' not found, left unset`)
              }
              const { basedOnPricelistName: _ignored, ...itemFields } = row.itemInput
              const itemToValidate: PricelistItemInput = { ...itemFields, basedOnPricelistId }

              const current = await tx.odooPricelist.findUnique({ where: { id: pricelistId }, select: { items: true } })
              const items = ((current?.items as unknown as PricelistItemInput[]) ?? []).slice()
              const existingIdx = row.itemId ? items.findIndex(it => it.id === row.itemId) : -1
              // ⛔ seenIds 必须排除"正在被这一行原地替换"的那条规则自己的 id——否则
              // validateAndNormalizeItem 会把"这行传来的 id 跟库里已有的撞了"误判成真撞车，
              // 凭空把这条规则的 id 重新生成一个，而不是原地更新(实测复现：itemId 对不上导致
              // 下次再按同一个 Item ID 导入时找不到这条规则，又会多插入一条而不是更新)。
              const seenIds = new Set(
                items.filter((_, idx) => idx !== existingIdx).map(it => it.id).filter((v): v is string => !!v),
              )
              try {
                const normalized = validateAndNormalizeItem(itemToValidate, seenIds)
                if (existingIdx >= 0) items[existingIdx] = normalized
                else items.push(normalized)
                await tx.odooPricelist.update({ where: { id: pricelistId }, data: { items: items as unknown as object[] } })
              } catch (e) {
                itemWarning = `${row.rowLabel}: ${e instanceof Error ? e.message : 'invalid item'}, item not added`
              }
            }

            return { id: pricelistId, isNewPricelist, itemWarning }
          })

          if (outcome.itemWarning) warnings.push(outcome.itemWarning)
          if (outcome.isNewPricelist) created++
          else updated++
        } catch (e) {
          console.error(`[POST /api/pricelists/bulk] ${row.rowLabel}`, e)
          let reason: string
          if (isUniqueConstraintError(e)) reason = row.externalId ? `ID '${row.externalId}' already used by another pricelist, row not imported` : 'a unique field already used by another pricelist, row not imported'
          else if (isTransactionTimeoutError(e)) reason = 'database timed out, row not imported — please re-import this row'
          else reason = lastErrorLine(e)
          failed.push(`${row.rowLabel}: ${reason}`)
        }
      }

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'CREATE', resource: 'pricelist', resourceId: 'bulk',
        detail: `批量导入价格表：新建 ${created}，更新 ${updated}，失败 ${failed.length}`,
      })

      return NextResponse.json({ created, updated, skipped: [], failed, warnings })
    } catch (error) {
      console.error('[POST /api/pricelists/bulk]', error)
      return NextResponse.json({ error: '批量导入失败' }, { status: 500 })
    }
  }, { require: 'master.pricelist.update' })
}
