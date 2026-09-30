import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { normalizeAndValidateSaleUomItems, upsertProductSaleUomRows } from '@/lib/product-sale-uom-upsert'

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
      // 归一化 + 校验 + 落库逻辑抽到 lib/product-sale-uom-upsert.ts(20260930)，
      // 与商品批量导入共用一份实现，见该文件顶部注释。
      const templateUomId: string | null = product.uomId ?? null
      const { items: normalizedItems, error: validationError } = normalizeAndValidateSaleUomItems(items, templateUomId)
      if (validationError) return NextResponse.json({ error: validationError }, { status: 400 })

      await prisma.$transaction(async (tx) => {
        await upsertProductSaleUomRows(tx, id, templateUomId, normalizedItems, user.name || user.email)
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
