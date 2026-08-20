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

      const product = await px.product.findUnique({ where: { id }, select: { id: true, name: true, templateId: true } })
      if (!product) return NextResponse.json({ error: '商品不存在' }, { status: 404 })

      const validationError = validateSaleUomItems(items)
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })
      const uomIds = items.map((it: { uomId?: string }) => String(it.uomId ?? ''))

      await prisma.$transaction(async (tx) => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const txAny = tx as any
        await txAny.productSaleUom.deleteMany({
          where: { productId: id, uomId: { notIn: uomIds } },
        })
        // 把模板的销售单位同步成基础单位。
        //
        // 两者不一致时，订单行的单位下拉会同时列出「模板销售单位」和「基础单位」两项，
        // 而选中前者时换算系数回落到 1 —— 价格和库存都会悄悄算错，且界面上看不出区别。
        // 基础单位是**库存的计数单位**，模板销售单位是**下单默认选中的单位**，
        // 业务上它们本来就该是同一个；这里直接对齐，从源头消除分叉。
        // 顺带修掉「模板没设销售单位」（生产 152 个 ACTIVE 模板）的商品 ——
        // 它们只要配了多规格，这里就会把 uomId 补上。
        const baseItem = items.find((it: { isDefault?: boolean }) => it.isDefault)
        if (baseItem?.uomId) {
          await txAny.productTemplate.update({
            where: { id: product.templateId },
            data: { uomId: String(baseItem.uomId) },
          })
        }

        for (const it of items) {
          await txAny.productSaleUom.upsert({
            where: { productId_uomId: { productId: id, uomId: it.uomId } },
            create: {
              productId: id,
              uomId: it.uomId,
              isDefault: !!it.isDefault,
              // 基础单位对自己的换算只能是 1，其余按输入（空/非法回落到 1）
              factor: it.isDefault ? 1 : normalizeFactor(it.factor),
              priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
              active: it.active !== false,
            },
            update: {
              isDefault: !!it.isDefault,
              factor: it.isDefault ? 1 : normalizeFactor(it.factor),
              priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
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
