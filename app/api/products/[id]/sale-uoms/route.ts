import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { validateSaleUomItems, normalizeFactor } from '@/lib/sale-uom'

/**
 * /api/products/[id]/sale-uoms — 商品可售单位(20260714 多单位销售试点)
 * ============================================================================
 * GET → 该商品配置的可售单位列表(含 uom 名称)
 * PUT → 整份替换(body: { items: [{ uomId, isDefault, factor, priceOverride, active }] })，
 *       前端"可售单位"区块一次性保存全部配置，不做逐条增删的 API。
 *
 * `factor` = 1 个此单位等于多少个**基础单位**（isDefault 那一行，其 factor 恒为 1）。
 * 20260819 起换算走它，不再走全局 `Uom.factor` —— 同名 CASE 在不同商品里箱规不同。
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const px = prisma as any

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async () => {
    try {
      const rows = await px.productSaleUom.findMany({
        where: { productId: id },
        include: { uom: { select: { id: true, name: true, nameZh: true, factor: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return NextResponse.json(serializeApi(rows))
    } catch (error) {
      console.error('[GET /api/products/[id]/sale-uoms]', error)
      return NextResponse.json({ error: '获取可售单位失败' }, { status: 500 })
    }
  })
}

export async function PUT(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  return withAuth(req, async (user) => {
    try {
      const body = await req.json()
      const items = Array.isArray(body.items) ? body.items : []

      const product = await px.product.findUnique({
        where: { id },
        select: { id: true, name: true, uomId: true },
      })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      // 基准单位单一入口(20260823)：只有页头「Unit of Measure」下拉框能改基准单位，
      // 这里的 isDefault 变成纯派生 —— 等于 product.uomId 的那一行才是基础行；
      // 服务端据此重新计算，忽略客户端提交的每行 isDefault。
      // 商品尚未设置销售单位时（历史遗留、从未设置过）维持旧行为：按客户端提交的 isDefault 回填一次。
      const templateUomId: string | null = product.uomId ?? null
      let normalizedItems: Array<Record<string, unknown>> = items
      if (templateUomId) {
        normalizedItems = items.map((it: { uomId?: string; factor?: unknown }) => {
          const isDefault = String(it.uomId ?? '') === templateUomId
          // 换基准单位后，新变成基础的那一行系数可能还留着换基准单位前的旧值（如 0.025）——
          // 基础单位的换算只能是 1，这里直接归一，而不是拿一个用户没机会去改的旧数字挡住保存。
          return { ...it, isDefault, factor: isDefault ? 1 : it.factor }
        })
        if (!normalizedItems.some(it => it.isDefault)) {
          // 提交的行里没有一行等于当前基准单位：自动补一行（factor=1, priceOverride=null）一起存，
          // 不要求用户先手动把基准单位加进列表才能保存其余行。
          normalizedItems = [...normalizedItems, { uomId: templateUomId, isDefault: true, factor: 1, priceOverride: null, active: true }]
        }
      }

      const validationError = validateSaleUomItems(normalizedItems)
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
      const uomIds = normalizedItems.map((it) => String(it.uomId ?? ''))

      await prisma.$transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny = tx as any
        await txAny.productSaleUom.deleteMany({
          where: { productId: id, uomId: { notIn: uomIds } },
        })

        if (!templateUomId) {
          // 商品还没设过销售单位（生产历史遗留）：顺带补一次 ——
          // 老逻辑「顺带修掉没设销售单位」的兜底价值还在，只是从
          // 「每次都覆盖」降级成「仅当前商品还没设过才补一次」。
          const baseItem = normalizedItems.find(it => it.isDefault)
          if (baseItem?.uomId) {
            await txAny.product.update({
              where: { id: product.id },
              data: { uomId: String(baseItem.uomId) },
            })
          }
        }

        for (const it of normalizedItems) {
          const priceMode = it.priceMode === 'FIXED' || it.priceMode === 'FORMULA' ? it.priceMode : 'AUTO'
          const priceDiscountPct = it.priceDiscountPct != null && it.priceDiscountPct !== '' ? Number(it.priceDiscountPct) : 0
          const priceSurcharge = it.priceSurcharge != null && it.priceSurcharge !== '' ? Number(it.priceSurcharge) : 0
          // 20260901：提成价照抄价格机制，写法与上面四行一一对应
          const commissionPriceMode = it.commissionPriceMode === 'FIXED' || it.commissionPriceMode === 'FORMULA' ? it.commissionPriceMode : 'AUTO'
          const commissionDiscountPct = it.commissionDiscountPct != null && it.commissionDiscountPct !== '' ? Number(it.commissionDiscountPct) : 0
          const commissionSurcharge = it.commissionSurcharge != null && it.commissionSurcharge !== '' ? Number(it.commissionSurcharge) : 0
          const spec = typeof it.spec === 'string' && it.spec.trim() ? it.spec.trim() : null
          await txAny.productSaleUom.upsert({
            where: { productId_uomId: { productId: id, uomId: it.uomId } },
            create: {
              productId: id,
              uomId: it.uomId,
              isDefault: !!it.isDefault,
              // 基础单位对自己的换算只能是 1，其余按输入（空/非法回落到 1）
              factor: it.isDefault ? 1 : normalizeFactor(it.factor as number | string | null | undefined),
              priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
              priceMode, priceDiscountPct, priceSurcharge,
              commissionPriceOverride: it.commissionPriceOverride != null ? Number(it.commissionPriceOverride) : null,
              commissionPriceMode, commissionDiscountPct, commissionSurcharge,
              spec,
              active: it.active !== false,
            },
            update: {
              isDefault: !!it.isDefault,
              factor: it.isDefault ? 1 : normalizeFactor(it.factor as number | string | null | undefined),
              priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
              priceMode, priceDiscountPct, priceSurcharge,
              commissionPriceOverride: it.commissionPriceOverride != null ? Number(it.commissionPriceOverride) : null,
              commissionPriceMode, commissionDiscountPct, commissionSurcharge,
              spec,
              active: it.active !== false,
            },
          })
        }
      })

      await writeLog({
        userId: user.userId, userEmail: user.email, userName: user.name,
        action: 'UPDATE', resource: 'product_sale_uom', resourceId: id,
        detail: `更新商品「${product.name}」可售单位：共 ${items.length} 个`,
      })

      const rows = await px.productSaleUom.findMany({
        where: { productId: id },
        include: { uom: { select: { id: true, name: true, nameZh: true, factor: true } } },
        orderBy: { createdAt: 'asc' },
      })
      return NextResponse.json(serializeApi(rows))
    } catch (error) {
      console.error('[PUT /api/products/[id]/sale-uoms]', error)
      return NextResponse.json({ error: '保存可售单位失败' }, { status: 500 })
    }
  }, { require: 'master.product.update' })
}
