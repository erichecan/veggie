import { NextResponse } from 'next/server'
import { prisma } from '@/lib/db'
import { withAuth } from '@/lib/auth'
import { writeLog } from '@/lib/action-log'
import { serializeApi } from '@/lib/api-serializer'
import { validateSaleUomItems } from '@/lib/sale-uom'

/**
 * /api/products/[id]/sale-uoms — 商品可售单位(20260714 多单位销售试点)
 * ============================================================================
 * GET → 该商品配置的可售单位列表(含 uom 名称)
 * PUT → 整份替换(body: { items: [{ uomId, isDefault, priceOverride, active }] })，
 *       前端"可售单位"区块一次性保存全部配置，不做逐条增删的 API。
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

      const product = await px.product.findUnique({ where: { id }, select: { id: true, name: true } })
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
        for (const it of items) {
          await txAny.productSaleUom.upsert({
            where: { productId_uomId: { productId: id, uomId: it.uomId } },
            create: {
              productId: id,
              uomId: it.uomId,
              isDefault: !!it.isDefault,
              priceOverride: it.priceOverride != null ? Number(it.priceOverride) : null,
              active: it.active !== false,
            },
            update: {
              isDefault: !!it.isDefault,
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
